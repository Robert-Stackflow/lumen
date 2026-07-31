#include "auth.h"

#include <json-c/json.h>
#include <fcntl.h>
#include <sys/file.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define PREFERENCES_MAX 131072

static bool add_boolean(json_object *source, json_object *target, const char *key) {
  json_object *value = NULL;
  if (!json_object_object_get_ex(source, key, &value)) return true;
  if (!json_object_is_type(value, json_type_boolean)) return false;
  json_object_object_add(target, key, json_object_new_boolean(json_object_get_boolean(value)));
  return true;
}

static bool add_integer(json_object *source, json_object *target, const char *key, int minimum, int maximum) {
  json_object *value = NULL;
  if (!json_object_object_get_ex(source, key, &value)) return true;
  if (!json_object_is_type(value, json_type_int)) return false;
  int parsed = json_object_get_int(value);
  if (parsed < minimum || parsed > maximum) return false;
  json_object_object_add(target, key, json_object_new_int(parsed));
  return true;
}

static bool add_number(json_object *source, json_object *target, const char *key, double minimum, double maximum) {
  json_object *value = NULL;
  if (!json_object_object_get_ex(source, key, &value)) return true;
  if (!json_object_is_type(value, json_type_double) && !json_object_is_type(value, json_type_int)) return false;
  double parsed = json_object_get_double(value);
  if (parsed < minimum || parsed > maximum) return false;
  json_object_object_add(target, key, json_object_new_double(parsed));
  return true;
}

static bool add_string(json_object *source, json_object *target, const char *key, size_t maximum,
                       const char *const *allowed, size_t allowed_count) {
  json_object *value = NULL;
  if (!json_object_object_get_ex(source, key, &value)) return true;
  if (!json_object_is_type(value, json_type_string)) return false;
  const char *parsed = json_object_get_string(value);
  size_t length = strlen(parsed);
  if (length > maximum) return false;
  for (size_t i = 0; i < length; i++)
    if ((unsigned char)parsed[i] < 0x20 || (unsigned char)parsed[i] == 0x7f) return false;
  if (allowed_count) {
    bool found = false;
    for (size_t i = 0; i < allowed_count; i++)
      if (!strcmp(parsed, allowed[i])) found = true;
    if (!found) return false;
  }
  json_object_object_add(target, key, json_object_new_string(parsed));
  return true;
}

static bool add_session_notes(json_object *source, json_object *target) {
  json_object *notes = NULL;
  if (!json_object_object_get_ex(source, "sessionNotes", &notes)) return true;
  if (!json_object_is_type(notes, json_type_object) || json_object_object_length(notes) > 128) return false;
  json_object *normalized = json_object_new_object();
  if (!normalized) return false;
  json_object_object_foreach(notes, key, value) {
    size_t key_length = strlen(key);
    if (!key_length || key_length > 64 || !json_object_is_type(value, json_type_string)) {
      json_object_put(normalized);
      return false;
    }
    for (size_t i = 0; i < key_length; i++) {
      char c = key[i];
      if (!(c == '-' || c == '_' || (c >= '0' && c <= '9') ||
            (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'))) {
        json_object_put(normalized);
        return false;
      }
    }
    const char *note = json_object_get_string(value);
    if (strlen(note) > 160) {
      json_object_put(normalized);
      return false;
    }
    json_object_object_add(normalized, key, json_object_new_string(note));
  }
  json_object_object_add(target, "sessionNotes", normalized);
  return true;
}

static bool add_command_snippets(json_object *source, json_object *target) {
  json_object *snippets = NULL;
  if (!json_object_object_get_ex(source, "commandSnippets", &snippets)) return true;
  if (!json_object_is_type(snippets, json_type_array) || json_object_array_length(snippets) > 40) return false;
  json_object *normalized = json_object_new_array();
  if (!normalized) return false;
  for (size_t i = 0; i < json_object_array_length(snippets); i++) {
    json_object *item = json_object_array_get_idx(snippets, i);
    json_object *id = NULL, *name = NULL, *command = NULL, *run = NULL;
    if (!json_object_is_type(item, json_type_object) ||
        !json_object_object_get_ex(item, "id", &id) ||
        !json_object_object_get_ex(item, "name", &name) ||
        !json_object_object_get_ex(item, "command", &command) ||
        !json_object_is_type(id, json_type_string) ||
        !json_object_is_type(name, json_type_string) ||
        !json_object_is_type(command, json_type_string) ||
        strlen(json_object_get_string(id)) > 64 ||
        strlen(json_object_get_string(name)) > 40 ||
        strlen(json_object_get_string(command)) > 2000) {
      json_object_put(normalized);
      return false;
    }
    json_object *copy = json_object_new_object();
    json_object_object_add(copy, "id", json_object_new_string(json_object_get_string(id)));
    json_object_object_add(copy, "name", json_object_new_string(json_object_get_string(name)));
    json_object_object_add(copy, "command", json_object_new_string(json_object_get_string(command)));
    json_object_object_add(copy, "run", json_object_new_boolean(
      json_object_object_get_ex(item, "run", &run) && json_object_get_boolean(run)));
    json_object_array_add(normalized, copy);
  }
  json_object_object_add(target, "commandSnippets", normalized);
  return true;
}

static json_object *normalize_preferences(const char *json) {
  json_object *source = json_tokener_parse(json);
  if (!source || !json_object_is_type(source, json_type_object)) {
    if (source) json_object_put(source);
    return NULL;
  }
  json_object *target = json_object_new_object();
  static const char *cursor_styles[] = {"bar", "block", "underline"};
  static const char *themes[] = {"dark", "light", "system"};
  static const char *font_families[] = {"system", "jetbrains", "cascadia"};
  bool valid = target &&
               add_boolean(source, target, "copySelection") &&
               add_integer(source, target, "fontSize", 11, 20) &&
               add_string(source, target, "fontFamily", 16, font_families, 3) &&
               add_integer(source, target, "fontWeight", 300, 700) &&
               add_number(source, target, "letterSpacing", -1.0, 2.0) &&
               add_integer(source, target, "scrollback", 1000, 50000) &&
               add_string(source, target, "cursorStyle", 16, cursor_styles, 3) &&
               add_boolean(source, target, "cursorBlink") &&
               add_number(source, target, "lineHeight", 1.0, 1.6) &&
               add_string(source, target, "workingDirectory", 240, NULL, 0) &&
               add_boolean(source, target, "inheritWorkingDirectory") &&
               add_boolean(source, target, "persistTerminalState") &&
               add_session_notes(source, target) &&
               add_command_snippets(source, target) &&
               add_string(source, target, "theme", 16, themes, 3);
  json_object *shortcuts = NULL;
  if (valid && json_object_object_get_ex(source, "shortcuts", &shortcuts)) {
    if (!json_object_is_type(shortcuts, json_type_object)) {
      valid = false;
    } else {
      json_object *normalized = json_object_new_object();
      valid = normalized &&
              add_string(shortcuts, normalized, "search", 64, NULL, 0) &&
              add_string(shortcuts, normalized, "newTab", 64, NULL, 0);
      if (valid) json_object_object_add(target, "shortcuts", normalized);
      else if (normalized) json_object_put(normalized);
    }
  }
  json_object_put(source);
  if (!valid) {
    if (target) json_object_put(target);
    return NULL;
  }
  return target;
}

static uint64_t preferences_version(struct lumen_auth *auth) {
  struct stat status;
  if (!auth || stat(auth->preferences_file, &status) != 0) return 0;
  return ((uint64_t)status.st_mtime << 32) ^
         ((uint64_t)status.st_mtim.tv_nsec << 2) ^ (uint64_t)status.st_size;
}

char *lumen_auth_preferences_get(struct lumen_auth *auth, uint64_t *version) {
  if (version) *version = preferences_version(auth);
  if (!auth || !auth->preferences_file[0]) return strdup("{}");
  FILE *file = fopen(auth->preferences_file, "r");
  if (!file) return strdup("{}");
  char buffer[PREFERENCES_MAX + 1];
  size_t length = fread(buffer, 1, PREFERENCES_MAX, file);
  bool valid_read = !ferror(file) && feof(file);
  fclose(file);
  if (!valid_read) return strdup("{}");
  buffer[length] = '\0';
  json_object *normalized = normalize_preferences(buffer);
  if (!normalized) return strdup("{}");
  const char *serialized = json_object_to_json_string_ext(normalized, JSON_C_TO_STRING_PLAIN);
  char *result = strdup(serialized);
  json_object_put(normalized);
  return result;
}

bool lumen_auth_preferences_set(struct lumen_auth *auth, const char *json, bool *conflict) {
  if (conflict) *conflict = false;
  if (!auth || !auth->preferences_file[0] || !json || strlen(json) > PREFERENCES_MAX) return false;
  char lock_path[sizeof(auth->preferences_file) + 16];
  snprintf(lock_path, sizeof(lock_path), "%s.lock", auth->preferences_file);
  int lock_fd = open(lock_path, O_CREAT | O_RDWR | O_CLOEXEC, 0600);
  if (lock_fd < 0 || flock(lock_fd, LOCK_EX) != 0) {
    if (lock_fd >= 0) close(lock_fd);
    return false;
  }

  json_object *request = json_tokener_parse(json);
  json_object *patch = NULL;
  json_object *base_version_object = NULL;
  if (!request || !json_object_is_type(request, json_type_object)) goto fail;
  if (!json_object_object_get_ex(request, "patch", &patch)) patch = request;
  if (!json_object_is_type(patch, json_type_object)) goto fail;
  if (json_object_object_get_ex(request, "baseVersion", &base_version_object)) {
    uint64_t expected = (uint64_t)json_object_get_int64(base_version_object);
    uint64_t current = preferences_version(auth);
    if (expected != current) {
      if (conflict) *conflict = true;
      goto fail;
    }
  }

  char *current_json = lumen_auth_preferences_get(auth, NULL);
  json_object *merged = current_json ? json_tokener_parse(current_json) : json_object_new_object();
  free(current_json);
  if (!merged || !json_object_is_type(merged, json_type_object)) {
    if (merged) json_object_put(merged);
    merged = json_object_new_object();
  }
  if (!merged) goto fail;
  json_object_object_foreach(patch, key, value) {
    json_object_object_add(merged, key, json_object_get(value));
  }
  const char *merged_json = json_object_to_json_string_ext(merged, JSON_C_TO_STRING_PLAIN);
  json_object *normalized = normalize_preferences(merged_json);
  json_object_put(merged);
  if (!normalized) goto fail;
  const char *serialized = json_object_to_json_string_ext(normalized, JSON_C_TO_STRING_PLAIN);
  char temporary[sizeof(auth->preferences_file) + 32];
  snprintf(temporary, sizeof(temporary), "%s.tmp.%ld", auth->preferences_file, (long)getpid());
  FILE *file = fopen(temporary, "w");
  if (!file) {
    json_object_put(normalized);
    goto fail;
  }
  chmod(temporary, 0600);
  bool saved = fprintf(file, "%s\n", serialized) >= 0;
  if (saved && fflush(file) != 0) saved = false;
  if (saved && fsync(fileno(file)) != 0) saved = false;
  if (fclose(file) != 0) saved = false;
  if (saved && rename(temporary, auth->preferences_file) != 0) saved = false;
  if (saved) {
    char directory[sizeof(auth->preferences_file)];
    snprintf(directory, sizeof(directory), "%s", auth->preferences_file);
    char *slash = strrchr(directory, '/');
    if (slash) {
      *slash = '\0';
      int directory_fd = open(directory[0] ? directory : "/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
      if (directory_fd >= 0) {
        if (fsync(directory_fd) != 0) saved = false;
        close(directory_fd);
      }
    }
  }
  if (!saved) unlink(temporary);
  json_object_put(normalized);
  json_object_put(request);
  flock(lock_fd, LOCK_UN);
  close(lock_fd);
  return saved;

fail:
  if (request) json_object_put(request);
  flock(lock_fd, LOCK_UN);
  close(lock_fd);
  return false;
}
