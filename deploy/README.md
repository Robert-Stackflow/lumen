# Deployment profiles

Lumen's terminal, authentication, and network exposure are separate choices.
OpenResty is used on the current host only as the TLS/WebSocket proxy; it is
not a runtime dependency of Lumen.

The systemd deployment separates the short-lived web transport, the
`lumen-pty` supervisor identity, the unprivileged shell identity, and an
explicitly gated root supervisor. The
installer starts but never restarts the PTY supervisor during ordinary
updates, so restarting Lumen's HTTP/WebSocket layer does not terminate work.

## Public HTTPS behind a local proxy

```bash
sudo ./scripts/install.sh ubuntu terminal.example.com \
  --listen lo \
  --port 7681 \
  --client-ip-header X-Real-IP
```

Forward HTTPS and WebSocket traffic to `127.0.0.1:7681`. Preserve `Host` and
`Origin`, and overwrite (do not append an untrusted value to) `X-Real-IP`.
`openresty-terminal.conf` is one example.

## Private port behind an environment-owned forwarder

Bind a private interface or all interfaces, then let the environment map its
own port to it:

```bash
sudo ./scripts/install.sh ubuntu terminal.internal.example \
  --listen 0.0.0.0 \
  --port 9080
```

If the browser-facing endpoint is HTTPS, keep the default secure cookie even
when the hop from the forwarder to Lumen is HTTP. The forwarder must preserve
the browser-facing `Host` value and support WebSocket upgrade.

## Trusted LAN without TLS

```bash
sudo ./scripts/install.sh ubuntu terminal.lan \
  --listen 0.0.0.0 \
  --port 9080 \
  --insecure-cookie
```

This keeps Lumen's account/password session but permits its Cookie over HTTP.
Use it only on an isolated network because terminal traffic is unencrypted.

## Authentication profiles

`/etc/lumen-terminal/security.conf` supports:

- `mode=session`: built-in password and persistent device session.
- `mode=proxy`: trust an external identity header.
- `mode=off`: no authentication for a fully trusted environment.

Use `/opt/lumen-terminal/scripts/lumen-auth set-mode` and restart the service
after policy changes.

## Session supervisor

On a non-systemd environment, run Lumen's small PTY process under that
environment's long-lived process supervisor before starting the web process:

```bash
export LUMEN_PTY_SOCKET="$HOME/.local/state/lumen-terminal/pty.sock"
mkdir -p -m 0700 "$(dirname "$LUMEN_PTY_SOCKET")"
/opt/lumen-terminal/bin/lumen-pty --serve \
  --socket "$LUMEN_PTY_SOCKET" \
  --cwd "$HOME" \
  --history-bytes 2097152 \
  --max-sessions 16
```

Pass `/opt/lumen-terminal/bin/lumen-pty` as ttyd's command and include
`--url-arg`; each short-lived attach process discovers the supervisor through
`LUMEN_PTY_SOCKET`. The web process may be replaced independently and must not
own the supervisor.

When upgrading from the old tmux architecture, the installer leaves the old
service alive so active work is not destroyed. Verify the new web terminal,
then run the installer once from SSH/console with
`--replace-legacy-sessions` to remove that retired service.

## Privilege policy

The terminal service sets `NoNewPrivileges=true`, has an empty capability
bounding set, and never installs sudo rules. By default, ordinary `+` tabs
therefore remain the configured non-root account; an explicit persisted
setting can change the `+` action to request a gated root session.

The tab-strip menu has a separate “new root session” action. Root access uses
`/run/lumen-root-terminal/pty.sock` and tmux label `lumen-root`; the settings
page controls whether creation and attach require fresh TOTP or WebAuthn
verification. Verification is enabled by default. The initial limit and idle
policy come from `LUMEN_ROOT_MAX_SESSIONS` and
`LUMEN_ROOT_IDLE_SESSION_SECONDS` (2 sessions and 1800 seconds by default).
Root socket access uses its own Unix group and the daemon additionally verifies
the web process UID. Root create, attach, disconnect, and termination actions
are written to the security audit log.

## From-zero installation

The supported production target is a systemd-based Ubuntu or Debian host. The
bootstrap installs both runtime and build dependencies, including Node.js so
the JavaScript test suite is not silently skipped, runs `make check`, and then
invokes the production installer:

```bash
git clone https://github.com/Robert-Stackflow/lumen.git
cd lumen
sudo ./scripts/bootstrap-debian.sh ubuntu terminal.example.com \
  --listen lo --port 7681 --client-ip-header X-Real-IP
```

The bootstrap also installs `bubblewrap`. Its environment check reports hosts
that disable user namespaces, because Codex sandboxing needs both pieces.

The installer does not modify DNS, firewall policy, TLS certificates, or the
machine's existing reverse proxy. Those settings are environment-owned and an
incorrect automatic change could expose a root-capable terminal. Use
`openresty-terminal.conf` as a reviewed template and keep Lumen on loopback
until HTTPS and WebSocket forwarding have been verified.

## Read-only environment check

Run the preflight independently whenever the host or network configuration
changes:

```bash
./scripts/check-env.sh ubuntu terminal.example.com --listen lo --port 7681
./scripts/check-env.sh ubuntu terminal.example.com --installed
```

It checks the OS and systemd state, build commands and development libraries,
the shell account and login shell, Host syntax and DNS, bind interface, port
occupancy, minimum disk/memory headroom, user namespaces, installed paths,
services, and PTY sockets. Failures produce a non-zero exit status; warnings
identify conditions that deserve review but do not necessarily block Lumen.

## Post-install verification

`install.sh` runs this check automatically after every installation:

```bash
sudo ./scripts/verify-install.sh terminal.example.com
```

It verifies that all three units are enabled and active, both PTY sockets are
ready and accessible to the web identity, `/healthz` responds through the
configured bind address with the expected Host header, and sensitive files
have the expected modes. Use `--skip-verify` on `install.sh` only when an
unusual network namespace makes the local HTTP probe impossible, then perform
an equivalent check manually.

When verification fails, inspect the services without restarting the PTY
supervisors first:

```bash
systemctl status lumen-terminal lumen-pty lumen-root-pty
journalctl -u lumen-terminal -u lumen-pty -u lumen-root-pty --since -15min
sudo /opt/lumen-terminal/scripts/verify-install.sh terminal.example.com
```

## Upgrade, backup, and rollback

Upgrade from a fresh source checkout. This creates a timestamped archive under
`/var/backups/lumen-terminal`, runs the full test suite, installs the new web
and binaries, and performs post-install verification. The ordinary and root
PTY supervisors are started if absent but are not restarted, preserving active
tasks.

```bash
git pull --ff-only
sudo ./scripts/upgrade.sh ubuntu terminal.example.com \
  --listen lo --port 7681 --client-ip-header X-Real-IP
```

Create an additional backup or choose an explicit destination with:

```bash
sudo ./scripts/backup.sh
sudo ./scripts/backup.sh /secure/path/lumen-before-change.tar.gz
```

The archive contains installed programs, systemd units, security policy, audit
log, preferences, passkeys, TOTP state, and login sessions. It deliberately
does not contain live shell processes or tmux sessions. Archives are mode
`0600`; protect them as authentication secrets.

To roll back, use a backup created by this script. Restore validates every
archive path, makes a backup of the current state, restores ownership and
modes, reloads systemd, restarts only the web service, and verifies the result:

```bash
sudo ./scripts/restore-backup.sh \
  /var/backups/lumen-terminal/lumen-backup-20260801T120000Z.tar.gz
```

## Uninstall

The default uninstall creates a backup, removes programs and units, and keeps
configuration and authentication state. It refuses to continue if any normal
or root session exists:

```bash
sudo ./scripts/uninstall.sh
```

Ending sessions is intentionally explicit. Protected sessions are also ended
when this option is used:

```bash
sudo ./scripts/uninstall.sh --stop-sessions
```

For a complete purge, including credentials and optional system identities:

```bash
sudo ./scripts/uninstall.sh --stop-sessions --purge-data --remove-users
```

Every destructive invocation asks for a typed confirmation unless `--yes` is
provided for controlled automation. The backup path is printed before removal.

## Root policy configuration

`LUMEN_ROOT_MAX_SESSIONS` is the initial web-policy default. The setting page
can persist a value from 1 through 8 and can independently control default-root
creation and step-up verification. The root PTY supervisor has a fixed hard
capacity of 8 so increasing the persisted web policy does not require a daemon
restart. `LUMEN_ROOT_IDLE_SESSION_SECONDS` remains the service-side idle limit.
