#define _GNU_SOURCE

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pty.h>
#include <pwd.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define LUMEN_PROTOCOL_VERSION 1
#define LUMEN_ID_MAX 32
#define LUMEN_PACKET_DATA_MAX 16384
#define LUMEN_CLIENTS_MAX 64
#define LUMEN_HISTORY_DEFAULT (2U * 1024U * 1024U)
#define LUMEN_HISTORY_MAX (64U * 1024U * 1024U)
#define LUMEN_SESSIONS_DEFAULT 16U
#define LUMEN_SESSIONS_MAX 64U
#define LUMEN_QUEUE_EXTRA (256U * 1024U)
#define LUMEN_INPUT_MAX (1024U * 1024U)

enum message_type {
    MSG_HELLO = 1,
    MSG_INPUT = 2,
    MSG_RESIZE = 3,
    MSG_KILL = 4,
    MSG_LIST = 5,
    MSG_OUTPUT = 101,
    MSG_STATUS = 102,
    MSG_EXIT = 103,
    MSG_LIST_REPLY = 104,
};

enum status_code {
    STATUS_OK = 0,
    STATUS_NOT_FOUND = 3,
    STATUS_INVALID = 64,
    STATUS_UNAVAILABLE = 75,
};

struct __attribute__((packed)) message_header {
    uint8_t version;
    uint8_t type;
    uint16_t status;
    uint32_t length;
    uint16_t rows;
    uint16_t columns;
};

struct queued_packet {
    struct queued_packet *next;
    size_t length;
    unsigned char data[];
};

struct session {
    struct session *next;
    char id[LUMEN_ID_MAX + 1];
    pid_t pid;
    int master_fd;
    unsigned short rows;
    unsigned short columns;
    unsigned char *history;
    size_t history_capacity;
    size_t history_allocated;
    size_t history_start;
    size_t history_length;
    bool history_truncated;
    unsigned char *input;
    size_t input_length;
    int64_t terminate_deadline_ms;
};

struct client {
    struct client *next;
    int fd;
    struct session *session;
    struct queued_packet *queue_head;
    struct queued_packet *queue_tail;
    size_t queued_bytes;
    bool close_after_flush;
};

struct server_config {
    const char *socket_path;
    const char *shell;
    const char *working_directory;
    size_t history_bytes;
    unsigned int max_sessions;
};

static volatile sig_atomic_t server_stopping;
static volatile sig_atomic_t child_changed;
static volatile sig_atomic_t client_resized;
static struct termios saved_termios;
static bool saved_termios_valid;

static void restore_client_terminal(void) {
    if (saved_termios_valid) {
        tcsetattr(STDIN_FILENO, TCSANOW, &saved_termios);
        saved_termios_valid = false;
    }
}

static void server_signal_handler(int signal_number) {
    if (signal_number == SIGCHLD) {
        child_changed = 1;
    } else {
        server_stopping = 1;
    }
}

static void resize_signal_handler(int signal_number) {
    (void) signal_number;
    client_resized = 1;
}

static int64_t monotonic_milliseconds(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) {
        return 0;
    }
    return (int64_t) value.tv_sec * 1000 + value.tv_nsec / 1000000;
}

static int set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) {
        return -1;
    }
    return 0;
}

static bool valid_session_id(const char *value, size_t length) {
    if (length < 1 || length > LUMEN_ID_MAX || !isalnum((unsigned char) value[0]) ||
        isupper((unsigned char) value[0])) {
        return false;
    }
    for (size_t index = 0; index < length; index++) {
        unsigned char character = (unsigned char) value[index];
        if (!(islower(character) || isdigit(character) || character == '-')) {
            return false;
        }
    }
    return true;
}

static const char *default_socket_path(void) {
    const char *configured = getenv("LUMEN_PTY_SOCKET");
    return configured && configured[0] ? configured : "/tmp/lumen-pty.sock";
}

static int connect_to_server(const char *socket_path) {
    struct sockaddr_un address;
    if (strlen(socket_path) >= sizeof(address.sun_path)) {
        errno = ENAMETOOLONG;
        return -1;
    }

    int fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        return -1;
    }

    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    memcpy(address.sun_path, socket_path, strlen(socket_path) + 1);
    if (connect(fd, (struct sockaddr *) &address, sizeof(address)) != 0) {
        int saved_errno = errno;
        close(fd);
        errno = saved_errno;
        return -1;
    }
    return fd;
}

static size_t build_packet(unsigned char *target, size_t target_size, uint8_t type,
                           uint16_t status, uint16_t rows, uint16_t columns,
                           const void *payload, size_t payload_length) {
    if (payload_length > LUMEN_PACKET_DATA_MAX ||
        target_size < sizeof(struct message_header) + payload_length) {
        return 0;
    }

    struct message_header header = {
        .version = LUMEN_PROTOCOL_VERSION,
        .type = type,
        .status = htons(status),
        .length = htonl((uint32_t) payload_length),
        .rows = htons(rows),
        .columns = htons(columns),
    };
    memcpy(target, &header, sizeof(header));
    if (payload_length) {
        memcpy(target + sizeof(header), payload, payload_length);
    }
    return sizeof(header) + payload_length;
}

static bool parse_packet(const unsigned char *packet, size_t packet_length,
                         struct message_header *header, const unsigned char **payload) {
    if (packet_length < sizeof(*header)) {
        return false;
    }
    memcpy(header, packet, sizeof(*header));
    header->status = ntohs(header->status);
    header->length = ntohl(header->length);
    header->rows = ntohs(header->rows);
    header->columns = ntohs(header->columns);
    if (header->version != LUMEN_PROTOCOL_VERSION ||
        header->length > LUMEN_PACKET_DATA_MAX ||
        sizeof(*header) + header->length != packet_length) {
        return false;
    }
    *payload = packet + sizeof(*header);
    return true;
}

static int send_message_blocking(int fd, uint8_t type, uint16_t status,
                                 uint16_t rows, uint16_t columns,
                                 const void *payload, size_t payload_length) {
    unsigned char packet[sizeof(struct message_header) + LUMEN_PACKET_DATA_MAX];
    size_t length = build_packet(packet, sizeof(packet), type, status, rows, columns,
                                 payload, payload_length);
    if (!length) {
        errno = EMSGSIZE;
        return -1;
    }
    ssize_t written;
    do {
        written = send(fd, packet, length, MSG_NOSIGNAL);
    } while (written < 0 && errno == EINTR);
    if (written < 0) {
        return -1;
    }
    if ((size_t) written != length) {
        errno = EIO;
        return -1;
    }
    return 0;
}

static int receive_message_blocking(int fd, unsigned char *packet, size_t packet_size,
                                    struct message_header *header,
                                    const unsigned char **payload) {
    ssize_t received;
    do {
        received = recv(fd, packet, packet_size, 0);
    } while (received < 0 && errno == EINTR);
    if (received <= 0) {
        return -1;
    }
    if (!parse_packet(packet, (size_t) received, header, payload)) {
        errno = EPROTO;
        return -1;
    }
    return 0;
}

static int make_client_terminal_raw(void) {
    if (!isatty(STDIN_FILENO)) {
        return 0;
    }
    if (tcgetattr(STDIN_FILENO, &saved_termios) != 0) {
        return -1;
    }
    struct termios raw = saved_termios;
    cfmakeraw(&raw);
    if (tcsetattr(STDIN_FILENO, TCSANOW, &raw) != 0) {
        return -1;
    }
    saved_termios_valid = true;
    atexit(restore_client_terminal);
    return 0;
}

static void current_window_size(unsigned short *rows, unsigned short *columns) {
    struct winsize size = {0};
    if (ioctl(STDIN_FILENO, TIOCGWINSZ, &size) == 0) {
        if (size.ws_row) {
            *rows = size.ws_row;
        }
        if (size.ws_col) {
            *columns = size.ws_col;
        }
    }
}

static int write_all(int fd, const unsigned char *data, size_t length) {
    while (length) {
        ssize_t written = write(fd, data, length);
        if (written < 0 && errno == EINTR) {
            continue;
        }
        if (written < 0) {
            return -1;
        }
        data += written;
        length -= (size_t) written;
    }
    return 0;
}

static int attach_client(const char *socket_path, const char *session_id) {
    size_t id_length = strlen(session_id);
    if (!valid_session_id(session_id, id_length)) {
        fprintf(stderr, "Invalid terminal session id.\n");
        return STATUS_INVALID;
    }

    int fd = connect_to_server(socket_path);
    if (fd < 0) {
        fprintf(stderr, "Lumen PTY supervisor is unavailable: %s\n", strerror(errno));
        return STATUS_UNAVAILABLE;
    }

    unsigned short rows = 24;
    unsigned short columns = 80;
    current_window_size(&rows, &columns);
    if (send_message_blocking(fd, MSG_HELLO, 0, rows, columns,
                              session_id, id_length) != 0) {
        fprintf(stderr, "Could not attach to Lumen PTY: %s\n", strerror(errno));
        close(fd);
        return STATUS_UNAVAILABLE;
    }
    if (make_client_terminal_raw() != 0) {
        fprintf(stderr, "Could not configure terminal: %s\n", strerror(errno));
        close(fd);
        return STATUS_UNAVAILABLE;
    }

    struct sigaction resize_action = {0};
    resize_action.sa_handler = resize_signal_handler;
    sigemptyset(&resize_action.sa_mask);
    sigaction(SIGWINCH, &resize_action, NULL);

    unsigned char packet[sizeof(struct message_header) + LUMEN_PACKET_DATA_MAX];
    unsigned char input[LUMEN_PACKET_DATA_MAX];
    for (;;) {
        if (client_resized) {
            client_resized = 0;
            current_window_size(&rows, &columns);
            if (send_message_blocking(fd, MSG_RESIZE, 0, rows, columns, NULL, 0) != 0) {
                break;
            }
        }

        struct pollfd descriptors[2] = {
            {.fd = STDIN_FILENO, .events = POLLIN},
            {.fd = fd, .events = POLLIN},
        };
        int result = poll(descriptors, 2, -1);
        if (result < 0 && errno == EINTR) {
            continue;
        }
        if (result < 0) {
            break;
        }

        if (descriptors[0].revents & (POLLIN | POLLHUP)) {
            ssize_t received = read(STDIN_FILENO, input, sizeof(input));
            if (received <= 0 ||
                send_message_blocking(fd, MSG_INPUT, 0, 0, 0, input, (size_t) received) != 0) {
                break;
            }
        }
        if (descriptors[1].revents & POLLIN) {
            struct message_header header;
            const unsigned char *payload;
            if (receive_message_blocking(fd, packet, sizeof(packet), &header, &payload) != 0) {
                break;
            }
            if (header.type == MSG_OUTPUT) {
                if (write_all(STDOUT_FILENO, payload, header.length) != 0) {
                    break;
                }
            } else if (header.type == MSG_EXIT || header.type == MSG_STATUS) {
                restore_client_terminal();
                close(fd);
                return header.status;
            }
        }
        if ((descriptors[0].revents | descriptors[1].revents) &
            (POLLERR | POLLNVAL | POLLHUP)) {
            break;
        }
    }

    restore_client_terminal();
    close(fd);
    return STATUS_UNAVAILABLE;
}

static int control_client(const char *socket_path, uint8_t message_type,
                          const char *session_id) {
    size_t id_length = session_id ? strlen(session_id) : 0;
    if (session_id && !valid_session_id(session_id, id_length)) {
        fprintf(stderr, "Invalid terminal session id.\n");
        return STATUS_INVALID;
    }
    int fd = connect_to_server(socket_path);
    if (fd < 0) {
        fprintf(stderr, "Lumen PTY supervisor is unavailable: %s\n", strerror(errno));
        return STATUS_UNAVAILABLE;
    }
    if (send_message_blocking(fd, message_type, 0, 0, 0, session_id, id_length) != 0) {
        close(fd);
        return STATUS_UNAVAILABLE;
    }

    unsigned char packet[sizeof(struct message_header) + LUMEN_PACKET_DATA_MAX];
    struct message_header header;
    const unsigned char *payload;
    int result = STATUS_UNAVAILABLE;
    if (receive_message_blocking(fd, packet, sizeof(packet), &header, &payload) == 0) {
        if (header.type == MSG_LIST_REPLY) {
            if (write_all(STDOUT_FILENO, payload, header.length) == 0) {
                result = STATUS_OK;
            }
        } else if (header.type == MSG_STATUS) {
            result = header.status;
        }
    }
    close(fd);
    return result;
}

static bool grow_history(struct session *session, size_t required) {
    if (required <= session->history_allocated) {
        return true;
    }
    size_t allocation = session->history_allocated ? session->history_allocated : 4096;
    while (allocation < required && allocation < session->history_capacity) {
        size_t next = allocation * 2;
        allocation = next > session->history_capacity ? session->history_capacity : next;
    }
    unsigned char *history = malloc(allocation);
    if (!history) {
        return false;
    }
    if (session->history_length) {
        size_t first = session->history_allocated - session->history_start;
        if (first > session->history_length) {
            first = session->history_length;
        }
        memcpy(history, session->history + session->history_start, first);
        if (first < session->history_length) {
            memcpy(history + first, session->history, session->history_length - first);
        }
    }
    free(session->history);
    session->history = history;
    session->history_allocated = allocation;
    session->history_start = 0;
    return true;
}

static void append_history(struct session *session, const unsigned char *data, size_t length) {
    if (!session->history_capacity || !length) {
        return;
    }
    size_t required = session->history_length + length;
    if (required > session->history_capacity) {
        required = session->history_capacity;
    }
    if (!grow_history(session, required)) {
        return;
    }
    if (length >= session->history_capacity) {
        memcpy(session->history, data + length - session->history_capacity,
               session->history_capacity);
        session->history_start = 0;
        session->history_length = session->history_capacity;
        session->history_truncated = true;
        return;
    }

    required = session->history_length + length;
    if (required > session->history_capacity) {
        size_t discard = required - session->history_capacity;
        session->history_start = (session->history_start + discard) % session->history_allocated;
        session->history_length -= discard;
        session->history_truncated = true;
    }
    size_t end = (session->history_start + session->history_length) % session->history_allocated;
    size_t first = session->history_allocated - end;
    if (first > length) {
        first = length;
    }
    memcpy(session->history + end, data, first);
    if (first < length) {
        memcpy(session->history, data + first, length - first);
    }
    session->history_length += length;
}

static bool queue_packet(struct client *client, size_t queue_limit, uint8_t type,
                         uint16_t status, const void *payload, size_t payload_length) {
    size_t packet_length = sizeof(struct message_header) + payload_length;
    if (payload_length > LUMEN_PACKET_DATA_MAX ||
        client->queued_bytes + packet_length > queue_limit) {
        return false;
    }
    struct queued_packet *packet = malloc(sizeof(*packet) + packet_length);
    if (!packet) {
        return false;
    }
    packet->next = NULL;
    packet->length = build_packet(packet->data, packet_length, type, status, 0, 0,
                                  payload, payload_length);
    if (!packet->length) {
        free(packet);
        return false;
    }
    if (client->queue_tail) {
        client->queue_tail->next = packet;
    } else {
        client->queue_head = packet;
    }
    client->queue_tail = packet;
    client->queued_bytes += packet->length;
    return true;
}

static bool flush_client(struct client *client) {
    while (client->queue_head) {
        struct queued_packet *packet = client->queue_head;
        ssize_t written = send(client->fd, packet->data, packet->length,
                               MSG_DONTWAIT | MSG_NOSIGNAL);
        if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            return true;
        }
        if (written < 0 && errno == EINTR) {
            continue;
        }
        if (written < 0 || (size_t) written != packet->length) {
            return false;
        }
        client->queue_head = packet->next;
        if (!client->queue_head) {
            client->queue_tail = NULL;
        }
        client->queued_bytes -= packet->length;
        free(packet);
    }
    return !client->close_after_flush;
}

static void free_client(struct client *client) {
    close(client->fd);
    while (client->queue_head) {
        struct queued_packet *packet = client->queue_head;
        client->queue_head = packet->next;
        free(packet);
    }
    free(client);
}

static unsigned int session_count(const struct session *sessions) {
    unsigned int count = 0;
    for (const struct session *session = sessions; session; session = session->next) {
        count++;
    }
    return count;
}

static unsigned int attached_client_count(const struct client *clients,
                                          const struct session *session) {
    unsigned int count = 0;
    for (const struct client *client = clients; client; client = client->next) {
        if (client->session == session) {
            count++;
        }
    }
    return count;
}

static struct session *find_session(struct session *sessions, const char *id) {
    for (struct session *session = sessions; session; session = session->next) {
        if (strcmp(session->id, id) == 0) {
            return session;
        }
    }
    return NULL;
}

static const char *shell_name(const char *shell) {
    const char *slash = strrchr(shell, '/');
    return slash ? slash + 1 : shell;
}

static int spawn_shell(struct session *session, const struct server_config *config,
                       unsigned short rows, unsigned short columns) {
    struct winsize size = {
        .ws_row = rows ? rows : 24,
        .ws_col = columns ? columns : 80,
    };
    int master_fd = -1;
    pid_t pid = forkpty(&master_fd, NULL, NULL, &size);
    if (pid < 0) {
        return -1;
    }
    if (pid == 0) {
        signal(SIGCHLD, SIG_DFL);
        signal(SIGTERM, SIG_DFL);
        signal(SIGINT, SIG_DFL);
        signal(SIGHUP, SIG_DFL);
        signal(SIGPIPE, SIG_DFL);
        setenv("TERM", "xterm-256color", 1);
        setenv("COLORTERM", "truecolor", 1);
        setenv("TERM_PROGRAM", "Lumen", 1);
        setenv("LUMEN_SESSION_ID", session->id, 1);
        if (chdir(config->working_directory) != 0) {
            dprintf(STDERR_FILENO, "Could not enter %s: %s\r\n",
                    config->working_directory, strerror(errno));
            _exit(126);
        }
        execl(config->shell, shell_name(config->shell), "-l", (char *) NULL);
        dprintf(STDERR_FILENO, "Could not start %s: %s\r\n",
                config->shell, strerror(errno));
        _exit(127);
    }

    if (set_nonblocking(master_fd) != 0 ||
        fcntl(master_fd, F_SETFD, FD_CLOEXEC) != 0) {
        int saved_errno = errno;
        close(master_fd);
        kill(-pid, SIGKILL);
        errno = saved_errno;
        return -1;
    }
    session->pid = pid;
    session->master_fd = master_fd;
    session->rows = size.ws_row;
    session->columns = size.ws_col;
    session->terminate_deadline_ms = 0;
    session->history_start = 0;
    session->history_length = 0;
    session->history_truncated = false;
    fprintf(stderr, "lumen-pty: started %s as pid %ld\n", session->id, (long) pid);
    return 0;
}

static struct session *create_session(struct session **sessions,
                                      const struct server_config *config,
                                      const char *id, unsigned short rows,
                                      unsigned short columns) {
    if (session_count(*sessions) >= config->max_sessions) {
        errno = ENOSPC;
        return NULL;
    }
    struct session *session = calloc(1, sizeof(*session));
    if (!session) {
        return NULL;
    }
    session->master_fd = -1;
    session->history_capacity = config->history_bytes;
    memcpy(session->id, id, strlen(id) + 1);
    if (spawn_shell(session, config, rows, columns) != 0) {
        free(session->history);
        free(session);
        return NULL;
    }
    session->next = *sessions;
    *sessions = session;
    return session;
}

static void resize_session(struct session *session, unsigned short rows,
                           unsigned short columns) {
    if (!session || session->master_fd < 0 || !rows || !columns) {
        return;
    }
    if (session->rows == rows && session->columns == columns) {
        return;
    }
    struct winsize size = {.ws_row = rows, .ws_col = columns};
    if (ioctl(session->master_fd, TIOCSWINSZ, &size) == 0) {
        session->rows = rows;
        session->columns = columns;
    }
}

static void redraw_session(struct session *session) {
    if (!session || session->master_fd < 0) {
        return;
    }
    pid_t foreground = tcgetpgrp(session->master_fd);
    if (foreground > 0) {
        kill(-foreground, SIGWINCH);
    }
}

static void signal_session(struct session *session, int signal_number) {
    if (!session || session->pid <= 0) {
        return;
    }
    pid_t foreground = session->master_fd >= 0 ? tcgetpgrp(session->master_fd) : -1;
    if (foreground > 0 && foreground != session->pid) {
        kill(-foreground, signal_number);
    }
    kill(-session->pid, signal_number);
}

static bool queue_session_input(struct session *session, const unsigned char *data,
                                size_t length) {
    if (!session || session->master_fd < 0 || !length) {
        return session != NULL;
    }
    if (!session->input_length) {
        ssize_t written = write(session->master_fd, data, length);
        if (written > 0) {
            data += written;
            length -= (size_t) written;
        } else if (written < 0 && errno != EAGAIN && errno != EWOULDBLOCK &&
                   errno != EINTR) {
            return false;
        }
    }
    if (!length) {
        return true;
    }
    if (session->input_length + length > LUMEN_INPUT_MAX) {
        return false;
    }
    unsigned char *next = realloc(session->input, session->input_length + length);
    if (!next) {
        return false;
    }
    session->input = next;
    memcpy(session->input + session->input_length, data, length);
    session->input_length += length;
    return true;
}

static bool flush_session_input(struct session *session) {
    while (session->input_length) {
        ssize_t written = write(session->master_fd, session->input, session->input_length);
        if (written < 0 && errno == EINTR) {
            continue;
        }
        if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            return true;
        }
        if (written <= 0) {
            return false;
        }
        session->input_length -= (size_t) written;
        if (session->input_length) {
            memmove(session->input, session->input + written, session->input_length);
        }
    }
    free(session->input);
    session->input = NULL;
    return true;
}

static bool replay_session(struct client *client, const struct session *session,
                           size_t queue_limit) {
    static const unsigned char reset[] = "\x1b" "c";
    if (!queue_packet(client, queue_limit, MSG_OUTPUT, 0, reset, sizeof(reset) - 1)) {
        return false;
    }
    size_t remaining = session->history_length;
    size_t offset = session->history_start;
    while (remaining) {
        size_t chunk = session->history_capacity - offset;
        if (chunk > remaining) {
            chunk = remaining;
        }
        if (chunk > LUMEN_PACKET_DATA_MAX) {
            chunk = LUMEN_PACKET_DATA_MAX;
        }
        if (!queue_packet(client, queue_limit, MSG_OUTPUT, 0,
                          session->history + offset, chunk)) {
            return false;
        }
        offset = (offset + chunk) % session->history_allocated;
        remaining -= chunk;
    }
    return true;
}

static void queue_session_output(struct client *clients, const struct session *session,
                                 size_t queue_limit, const unsigned char *data,
                                 size_t length) {
    for (struct client *client = clients; client; client = client->next) {
        if (client->session != session || client->close_after_flush) {
            continue;
        }
        size_t offset = 0;
        while (offset < length) {
            size_t chunk = length - offset;
            if (chunk > LUMEN_PACKET_DATA_MAX) {
                chunk = LUMEN_PACKET_DATA_MAX;
            }
            if (!queue_packet(client, queue_limit, MSG_OUTPUT, 0, data + offset, chunk)) {
                client->close_after_flush = true;
                break;
            }
            offset += chunk;
        }
    }
}

static void detach_dead_session_clients(struct client *clients,
                                        const struct session *session,
                                        size_t queue_limit, int exit_status) {
    for (struct client *client = clients; client; client = client->next) {
        if (client->session == session) {
            client->session = NULL;
            if (!queue_packet(client, queue_limit, MSG_EXIT,
                              (uint16_t) exit_status, NULL, 0)) {
                client->close_after_flush = true;
            } else {
                client->close_after_flush = true;
            }
        }
    }
}

static void remove_session(struct session **sessions, struct session *target) {
    struct session **cursor = sessions;
    while (*cursor && *cursor != target) {
        cursor = &(*cursor)->next;
    }
    if (!*cursor) {
        return;
    }
    *cursor = target->next;
    if (target->master_fd >= 0) {
        close(target->master_fd);
    }
    free(target->history);
    free(target->input);
    free(target);
}

static void reap_children(struct session **sessions, struct client *clients,
                          size_t queue_limit) {
    int status;
    pid_t pid;
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
        struct session *session = *sessions;
        while (session && session->pid != pid) {
            session = session->next;
        }
        if (!session) {
            continue;
        }
        int code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        fprintf(stderr, "lumen-pty: session %s exited with status %d\n",
                session->id, code);
        detach_dead_session_clients(clients, session, queue_limit, code);
        remove_session(sessions, session);
    }
    child_changed = 0;
}

static int create_listen_socket(const char *socket_path) {
    struct sockaddr_un address;
    if (strlen(socket_path) >= sizeof(address.sun_path)) {
        errno = ENAMETOOLONG;
        return -1;
    }

    int probe = connect_to_server(socket_path);
    if (probe >= 0) {
        close(probe);
        errno = EADDRINUSE;
        return -1;
    }
    if (errno != ENOENT && errno != ECONNREFUSED) {
        return -1;
    }
    if (errno == ECONNREFUSED && unlink(socket_path) != 0 && errno != ENOENT) {
        return -1;
    }

    int fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) {
        return -1;
    }
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    memcpy(address.sun_path, socket_path, strlen(socket_path) + 1);
    mode_t old_mask = umask(0077);
    int result = bind(fd, (struct sockaddr *) &address, sizeof(address));
    umask(old_mask);
    if (result != 0 || chmod(socket_path, 0600) != 0 || listen(fd, 32) != 0) {
        int saved_errno = errno;
        close(fd);
        if (result == 0) {
            unlink(socket_path);
        }
        errno = saved_errno;
        return -1;
    }
    return fd;
}

static bool client_has_expected_uid(int fd) {
#ifdef SO_PEERCRED
    struct ucred credentials;
    socklen_t length = sizeof(credentials);
    return getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) == 0 &&
           credentials.uid == getuid();
#else
    (void) fd;
    return true;
#endif
}

static struct client *accept_client(int listen_fd) {
    int fd = accept4(listen_fd, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
    if (fd < 0) {
        return NULL;
    }
    if (!client_has_expected_uid(fd)) {
        close(fd);
        errno = EACCES;
        return NULL;
    }
    struct client *client = calloc(1, sizeof(*client));
    if (!client) {
        close(fd);
        return NULL;
    }
    client->fd = fd;
    return client;
}

static bool queue_status_and_close(struct client *client, size_t queue_limit,
                                   uint16_t status) {
    client->close_after_flush = true;
    return queue_packet(client, queue_limit, MSG_STATUS, status, NULL, 0);
}

static bool handle_client_message(struct client *client, struct session **sessions,
                                  struct client *clients,
                                  const struct server_config *config,
                                  size_t queue_limit) {
    unsigned char packet[sizeof(struct message_header) + LUMEN_PACKET_DATA_MAX];
    ssize_t received = recv(client->fd, packet, sizeof(packet), MSG_DONTWAIT);
    if (received < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
        return true;
    }
    if (received < 0 && errno == EINTR) {
        return true;
    }
    if (received <= 0) {
        return false;
    }

    struct message_header header;
    const unsigned char *payload;
    if (!parse_packet(packet, (size_t) received, &header, &payload)) {
        queue_status_and_close(client, queue_limit, STATUS_INVALID);
        return true;
    }

    if (header.type == MSG_HELLO) {
        if (client->session || !valid_session_id((const char *) payload, header.length)) {
            queue_status_and_close(client, queue_limit, STATUS_INVALID);
            return true;
        }
        char id[LUMEN_ID_MAX + 1] = {0};
        memcpy(id, payload, header.length);
        struct session *session = find_session(*sessions, id);
        if (!session) {
            session = create_session(sessions, config, id, header.rows, header.columns);
        }
        if (!session) {
            queue_status_and_close(client, queue_limit, STATUS_UNAVAILABLE);
            return true;
        }
        client->session = session;
        if (!replay_session(client, session, queue_limit)) {
            return false;
        }
        resize_session(session, header.rows, header.columns);
        redraw_session(session);
        return true;
    }

    if (header.type == MSG_INPUT) {
        if (!client->session || !header.length) {
            return client->session != NULL;
        }
        return queue_session_input(client->session, payload, header.length);
    }

    if (header.type == MSG_RESIZE) {
        if (!client->session || header.length) {
            return false;
        }
        resize_session(client->session, header.rows, header.columns);
        return true;
    }

    if (header.type == MSG_KILL) {
        if (client->session || !valid_session_id((const char *) payload, header.length)) {
            queue_status_and_close(client, queue_limit, STATUS_INVALID);
            return true;
        }
        char id[LUMEN_ID_MAX + 1] = {0};
        memcpy(id, payload, header.length);
        struct session *session = find_session(*sessions, id);
        if (!session) {
            queue_status_and_close(client, queue_limit, STATUS_NOT_FOUND);
            return true;
        }
        signal_session(session, SIGHUP);
        session->terminate_deadline_ms = monotonic_milliseconds() + 2000;
        queue_status_and_close(client, queue_limit, STATUS_OK);
        return true;
    }

    if (header.type == MSG_LIST) {
        if (client->session || header.length) {
            queue_status_and_close(client, queue_limit, STATUS_INVALID);
            return true;
        }
        char list[LUMEN_PACKET_DATA_MAX];
        size_t used = 0;
        for (struct session *session = *sessions; session; session = session->next) {
            int written = snprintf(list + used, sizeof(list) - used,
                                   "%-32s pid=%-7ld clients=%u history=%zu%s\n",
                                   session->id, (long) session->pid,
                                   attached_client_count(clients, session),
                                   session->history_length,
                                   session->history_truncated ? " (ring)" : "");
            if (written < 0 || (size_t) written >= sizeof(list) - used) {
                break;
            }
            used += (size_t) written;
        }
        if (!used) {
            static const char empty[] = "No persistent PTY sessions.\n";
            memcpy(list, empty, sizeof(empty) - 1);
            used = sizeof(empty) - 1;
        }
        client->close_after_flush = true;
        return queue_packet(client, queue_limit, MSG_LIST_REPLY, STATUS_OK, list, used);
    }

    queue_status_and_close(client, queue_limit, STATUS_INVALID);
    return true;
}

static void terminate_expired_sessions(struct session *sessions) {
    int64_t now = monotonic_milliseconds();
    for (struct session *session = sessions; session; session = session->next) {
        if (session->terminate_deadline_ms && now >= session->terminate_deadline_ms) {
            signal_session(session, SIGKILL);
            session->terminate_deadline_ms = 0;
        }
    }
}

static int serve(const struct server_config *config) {
    int listen_fd = create_listen_socket(config->socket_path);
    if (listen_fd < 0) {
        fprintf(stderr, "Could not listen on %s: %s\n",
                config->socket_path, strerror(errno));
        return 1;
    }

    struct sigaction action = {0};
    action.sa_handler = server_signal_handler;
    sigemptyset(&action.sa_mask);
    sigaction(SIGCHLD, &action, NULL);
    sigaction(SIGTERM, &action, NULL);
    sigaction(SIGINT, &action, NULL);
    signal(SIGPIPE, SIG_IGN);

    struct session *sessions = NULL;
    struct client *clients = NULL;
    size_t queue_limit = config->history_bytes + LUMEN_QUEUE_EXTRA;
    fprintf(stderr, "lumen-pty: listening on %s (%zu byte replay, %u sessions)\n",
            config->socket_path, config->history_bytes, config->max_sessions);

    while (!server_stopping) {
        unsigned int client_total = 0;
        for (struct client *client = clients; client; client = client->next) {
            client_total++;
        }
        unsigned int session_total = session_count(sessions);
        size_t descriptor_count = 1 + client_total + session_total;
        struct pollfd descriptors[1 + LUMEN_CLIENTS_MAX + LUMEN_SESSIONS_MAX];
        void *owners[1 + LUMEN_CLIENTS_MAX + LUMEN_SESSIONS_MAX];
        unsigned char owner_types[1 + LUMEN_CLIENTS_MAX + LUMEN_SESSIONS_MAX];
        memset(descriptors, 0, sizeof(descriptors));
        memset(owners, 0, sizeof(owners));
        memset(owner_types, 0, sizeof(owner_types));

        size_t index = 0;
        descriptors[index].fd = listen_fd;
        descriptors[index].events = POLLIN;
        owner_types[index] = 1;
        index++;
        for (struct client *client = clients; client; client = client->next) {
            descriptors[index].fd = client->fd;
            descriptors[index].events = POLLIN;
            if (client->queue_head) {
                descriptors[index].events |= POLLOUT;
            }
            owners[index] = client;
            owner_types[index] = 2;
            index++;
        }
        for (struct session *session = sessions; session; session = session->next) {
            descriptors[index].fd = session->master_fd;
            descriptors[index].events = POLLIN;
            if (session->input_length) {
                descriptors[index].events |= POLLOUT;
            }
            owners[index] = session;
            owner_types[index] = 3;
            index++;
        }

        int result = poll(descriptors, descriptor_count, 500);
        if (result < 0 && errno != EINTR) {
            break;
        }

        if (descriptors[0].revents & POLLIN) {
            while (client_total < LUMEN_CLIENTS_MAX) {
                struct client *client = accept_client(listen_fd);
                if (!client) {
                    if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EACCES) {
                        fprintf(stderr, "lumen-pty: accept failed: %s\n", strerror(errno));
                    }
                    break;
                }
                client->next = clients;
                clients = client;
                client_total++;
            }
        }

        for (index = 1; index < descriptor_count; index++) {
            if (owner_types[index] == 2) {
                struct client *client = owners[index];
                if (client->fd < 0) {
                    continue;
                }
                short events = descriptors[index].revents;
                if ((events & POLLOUT) && !flush_client(client)) {
                    client->fd = -client->fd - 1;
                    continue;
                }
                if ((events & POLLIN) &&
                    !handle_client_message(client, &sessions, clients, config, queue_limit)) {
                    client->fd = -client->fd - 1;
                    continue;
                }
                if (events & (POLLERR | POLLHUP | POLLNVAL)) {
                    client->fd = -client->fd - 1;
                }
            } else if (owner_types[index] == 3) {
                struct session *session = owners[index];
                if (!find_session(sessions, session->id)) {
                    continue;
                }
                short events = descriptors[index].revents;
                if (events & POLLIN) {
                    unsigned char output[LUMEN_PACKET_DATA_MAX];
                    for (;;) {
                        ssize_t received = read(session->master_fd, output, sizeof(output));
                        if (received > 0) {
                            append_history(session, output, (size_t) received);
                            queue_session_output(clients, session, queue_limit,
                                                 output, (size_t) received);
                            continue;
                        }
                        if (received < 0 && errno == EINTR) {
                            continue;
                        }
                        break;
                    }
                }
                if ((events & POLLOUT) && !flush_session_input(session)) {
                    signal_session(session, SIGHUP);
                }
            }
        }

        struct client **client_cursor = &clients;
        while (*client_cursor) {
            struct client *client = *client_cursor;
            bool remove = client->fd < 0;
            if (!remove && client->close_after_flush && !client->queue_head) {
                remove = true;
            }
            if (remove) {
                if (client->fd < 0) {
                    client->fd = -client->fd - 1;
                }
                *client_cursor = client->next;
                free_client(client);
            } else {
                client_cursor = &client->next;
            }
        }

        terminate_expired_sessions(sessions);
        if (child_changed) {
            reap_children(&sessions, clients, queue_limit);
        }
    }

    close(listen_fd);
    unlink(config->socket_path);
    for (struct session *session = sessions; session; session = session->next) {
        signal_session(session, SIGTERM);
    }
    int64_t deadline = monotonic_milliseconds() + 1000;
    while (sessions && monotonic_milliseconds() < deadline) {
        reap_children(&sessions, clients, queue_limit);
        usleep(10000);
    }
    for (struct session *session = sessions; session; session = session->next) {
        signal_session(session, SIGKILL);
    }
    while (clients) {
        struct client *next = clients->next;
        free_client(clients);
        clients = next;
    }
    while (sessions) {
        struct session *next = sessions->next;
        if (sessions->master_fd >= 0) {
            close(sessions->master_fd);
        }
        free(sessions->history);
        free(sessions->input);
        free(sessions);
        sessions = next;
    }
    return 0;
}

static unsigned long parse_unsigned(const char *value, unsigned long minimum,
                                    unsigned long maximum, const char *name) {
    char *end = NULL;
    errno = 0;
    unsigned long result = strtoul(value, &end, 10);
    if (errno || !end || *end || result < minimum || result > maximum) {
        fprintf(stderr, "Invalid %s: %s\n", name, value);
        exit(STATUS_INVALID);
    }
    return result;
}

static void usage(FILE *stream) {
    fprintf(stream,
            "Usage:\n"
            "  lumen-pty <session-id>\n"
            "  lumen-pty --kill <session-id>\n"
            "  lumen-pty --list\n"
            "  lumen-pty --serve [--socket PATH] [--shell PATH] [--cwd PATH]\\\n"
            "             [--history-bytes N] [--max-sessions N]\n");
}

int main(int argc, char **argv) {
    const char *socket_path = default_socket_path();
    if (argc >= 2 && strcmp(argv[1], "--serve") == 0) {
        struct passwd *account = getpwuid(getuid());
        const char *home = getenv("HOME");
        struct server_config config = {
            .socket_path = socket_path,
            .shell = getenv("SHELL"),
            .working_directory = home,
            .history_bytes = LUMEN_HISTORY_DEFAULT,
            .max_sessions = LUMEN_SESSIONS_DEFAULT,
        };
        if (!config.shell || !config.shell[0]) {
            config.shell = account && account->pw_shell[0] ? account->pw_shell : "/bin/sh";
        }
        if (!config.working_directory || !config.working_directory[0]) {
            config.working_directory = account ? account->pw_dir : "/";
        }
        for (int index = 2; index < argc; index++) {
            if (strcmp(argv[index], "--socket") == 0 && index + 1 < argc) {
                config.socket_path = argv[++index];
            } else if (strcmp(argv[index], "--shell") == 0 && index + 1 < argc) {
                config.shell = argv[++index];
            } else if (strcmp(argv[index], "--cwd") == 0 && index + 1 < argc) {
                config.working_directory = argv[++index];
            } else if (strcmp(argv[index], "--history-bytes") == 0 && index + 1 < argc) {
                config.history_bytes = parse_unsigned(
                    argv[++index], 65536, LUMEN_HISTORY_MAX, "history size");
            } else if (strcmp(argv[index], "--max-sessions") == 0 && index + 1 < argc) {
                config.max_sessions = (unsigned int) parse_unsigned(
                    argv[++index], 1, LUMEN_SESSIONS_MAX, "maximum session count");
            } else {
                usage(stderr);
                return STATUS_INVALID;
            }
        }
        if (!config.socket_path[0] || access(config.shell, X_OK) != 0 ||
            access(config.working_directory, X_OK) != 0) {
            fprintf(stderr, "Invalid supervisor socket, shell, or working directory.\n");
            return STATUS_INVALID;
        }
        return serve(&config);
    }

    if (argc == 3 && strcmp(argv[1], "--kill") == 0) {
        return control_client(socket_path, MSG_KILL, argv[2]);
    }
    if (argc == 2 && strcmp(argv[1], "--list") == 0) {
        return control_client(socket_path, MSG_LIST, NULL);
    }
    if (argc == 2 && argv[1][0] != '-') {
        return attach_client(socket_path, argv[1]);
    }
    usage(argc == 2 && strcmp(argv[1], "--help") == 0 ? stdout : stderr);
    return argc == 2 && strcmp(argv[1], "--help") == 0 ? 0 : STATUS_INVALID;
}
