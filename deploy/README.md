# Deployment profiles

Lumen's terminal, authentication, and network exposure are separate choices.
OpenResty is used on the current host only as the TLS/WebSocket proxy; it is
not a runtime dependency of Lumen.

The systemd deployment also separates the short-lived web transport from
`lumen-pty.service`, which owns the real PTYs and shell processes. The
installer starts but never restarts the PTY supervisor during ordinary
updates, so restarting Lumen's HTTP/WebSocket layer does not terminate work.

## Public HTTPS behind a local proxy

```bash
sudo ./scripts/install.sh ubuntu terminal.example.com \
  --listen lo \
  --port 7681 \
  --client-ip-header X-Real-IP \
  --allow-sudo
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
  --port 9080 \
  --allow-sudo
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

## Root policy

The base service permits setuid escalation. `--allow-sudo` also installs an
explicit `NOPASSWD: ALL` rule for the selected shell user. If a deployment
must prohibit root, install `no-root-hardening.conf` as a systemd drop-in and
reload/restart systemd.
