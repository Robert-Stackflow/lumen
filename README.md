# Lumen Terminal

Lumen 是一个面向个人设备的轻量 Web terminal。界面采用克制的
Ghostty 风格；后端基于精简的 ttyd C/libuv 服务；每个浏览器标签连接
一个由 Lumen 管理、由 tmux 承载的持久 PTY。Web 与 PTY 管理进程都可独立
更新或重启，真实 shell 和后台任务仍会保留。

## 功能

- 多 terminal 标签，标签状态保存在浏览器本地。
- 每个标签通过自己的终端 WebSocket 测量真实 RTT。
- Ghostty 风格一体化标签栏、跟随系统的 Catppuccin 明暗主题和 WebGL2 渲染。
- 自动重连、流量背压、5,000 行浏览器 scrollback。
- 原生 xterm.js 鼠标、滚动和选择，并通过安全的 OSC 52 桥接到访问设备的系统剪贴板。
- 约束明确的 C PTY supervisor；Web 层更新、关闭网页或断网都不会终止任务。
- 关闭标签时明确选择“仅断开”或“结束会话并释放资源”。
- 手机快捷键栏，以及中文系统字体和 IME 兼容。
- 单文件前端，无 CDN、外部字体、常驻 Node、数据库或 Docker。

默认会话 ID 是 `main`。另一台电脑首次打开时也会连接
`main`，所以可以继续同一个 PTY 会话。更多标签采用
`term-2`、`term-3` 等稳定 ID；显示名称可以双击修改，但不会改变
服务端会话 ID。

## 延迟如何测量

Lumen 在 ttyd 协议中加入了很小的 `PING`/`PONG` 控制帧。每个标签
每秒通过自己的终端 WebSocket 发送一次；页面不可见时降为每五秒一次。
一个探针只有几个字节，并且与 PTY 输出共用发送队列，因此显示的 RTT
包含了该标签真实的网络、代理和输出排队延迟。

- 绿色：平滑 RTT 小于 80 ms。
- 黄色：80–180 ms。
- 红色：大于 180 ms 或探针超时。

## 内置认证

公网推荐架构：

```text
Browser
  │ HTTPS + WSS
TLS reverse proxy (OpenResty, nginx, Caddy, HAProxy...)
  │ loopback HTTP + WebSocket
Lumen 127.0.0.1:7681
  │ attach / detach
lumen-pty.service → real PTY → shell / Codex
```

TLS 代理只处理证书和转发。账号密码、登录限速与会话验证都由 Lumen
自己完成，因此代理不能意外绕过认证，也不会把部署绑定到某个面板。

`/etc/lumen-terminal/security.conf` 集中控制安全策略：

```ini
mode=session
username=Ran
password_hash=pbkdf2-sha256$600000$<salt>$<hash>
session_secret=<32-byte-random-secret>
session_generation=1
session_ttl_days=30
cookie_secure=true
allowed_host=terminal.example.com
proxy_header=X-Remote-User
client_ip_header=X-Real-IP
login_max_failures=5
login_window_seconds=300
login_lockout_seconds=300
rate_limit_state=/home/ubuntu/.local/state/lumen-terminal/login-rates
audit_log=/home/ubuntu/.local/state/lumen-terminal/security-audit.log
passkey_store=/home/ubuntu/.local/state/lumen-terminal/passkeys
totp_secret_file=/home/ubuntu/.local/state/lumen-terminal/totp-secret
preferences_file=/home/ubuntu/.local/state/lumen-terminal/preferences.json
max_connections_per_ip=4
ws_max_attempts=20
ws_rate_window_seconds=60
```

`session` 模式包含：

- PBKDF2-HMAC-SHA256 60 万次密码哈希和独立随机盐。
- 签名的随机设备会话；不在浏览器存储密码或可供 JavaScript 读取的令牌。
- `Secure`、`HttpOnly`、`SameSite=Strict`、host-only 持久 Cookie。
- Host 白名单、同源 Origin 和双提交 CSRF 校验；隐私浏览器发送 `Origin: null` 时仍须通过完整 CSRF 校验。
- 每个来源 IP 的持久化登录失败窗口，以及最长 24 小时的递增锁定。
- 可在设置中启用 TOTP 动态验证码，或注册要求用户验证的 WebAuthn 通行密钥。
- 每 IP WebSocket 并发与建连速率限制，以及不包含命令内容的安全审计日志。
- CSP、禁止 iframe、禁缓存、MIME 嗅探防护等响应头。

会话有效期默认为 30 天，每次正常打开页面会续期，所以经常使用的设备
不会反复要求登录。丢失设备时可一次撤销全部设备会话：

```bash
sudo /opt/lumen-terminal/scripts/lumen-auth revoke-sessions
sudo systemctl restart lumen-terminal
```

生成并更换密码（默认同时撤销旧会话）：

```bash
sudo /opt/lumen-terminal/scripts/lumen-auth set-password --generate
sudo systemctl restart lumen-terminal
```

明文密码只输出一次，配置文件仅保存哈希。安装后的策略文件使用
`root:root 0600`：进程先读取它，随后清空附加组、永久降权为目标用户，
并在开始监听前禁止进程 dump。终端 shell 无法读取认证密钥。

## 三种安全策略

认证不依赖 OpenResty，可以按环境切换：

| 模式 | 用途 | 说明 |
|---|---|---|
| `session` | 公网或不完全可信内网 | Lumen 自带登录、持久 Cookie、限速与锁定 |
| `proxy` | 已有 SSO / VPN 身份代理 | 只信任 `proxy_header`；Lumen 应仅监听代理可访问的地址 |
| `off` | 完全可信、隔离的开发内网 | 不认证；切勿直接暴露公网 |

切换为内网无认证：

```bash
sudo /opt/lumen-terminal/scripts/lumen-auth set-mode off
sudo systemctl restart lumen-terminal
```

切换到已有身份代理：

```bash
sudo /opt/lumen-terminal/scripts/lumen-auth set-mode proxy \
  --proxy-header X-Remote-User
sudo systemctl restart lumen-terminal
```

在没有反向代理的可信内网直接使用 HTTP session 时，把策略改为：

```ini
mode=session
cookie_secure=false
allowed_host=terminal.lan
client_ip_header=
```

安装时使用 `--listen 0.0.0.0 --port 9080`（或指定内网接口/IP）即可
直接绑定端口。HTTP 会暴露传输内容，只适用于可信且隔离的网络；公网必须
使用 HTTPS。Lumen 自带的 ttyd 后端也支持
`--ssl --ssl-cert ... --ssl-key ...`，可以在没有代理时直接终止 TLS。

## 构建与安装

生产部署支持使用 systemd 的 Ubuntu/Debian。全新机器可以从 GitHub
克隆后，用一个命令安装构建依赖、运行测试并部署：

```bash
git clone https://github.com/RanranranQAQ/lumen.git
cd lumen
sudo ./scripts/bootstrap-debian.sh ubuntu terminal.example.com \
  --listen lo \
  --port 7681 \
  --client-ip-header X-Real-IP
```

把 `ubuntu` 换成实际运行 shell 的现有非 root Linux 用户，把
`terminal.example.com` 换成浏览器访问时使用的 Host。命令完成后会打印
首次登录的随机密码；明文只显示一次。默认只监听回环地址，需要按
`deploy/README.md` 配置 HTTPS 反向代理。确实需要免密码 root 权限时，
再显式加上 `--allow-sudo`。

如果希望手动管理软件包，Ubuntu/Debian 构建依赖如下：

```bash
sudo apt-get install \
  build-essential cmake libjson-c-dev libuv1-dev \
  libwebsockets-dev zlib1g-dev libssl-dev

make check
```

开发预览只监听 loopback，并故意不启用认证：

```bash
./scripts/run-dev.sh
```

不要把开发模式端口映射到公网或局域网。

正式安装为现有的非 root 用户：

```bash
sudo ./scripts/install.sh ubuntu terminal.example.com \
  --listen lo \
  --port 7681 \
  --client-ip-header X-Real-IP \
  --allow-sudo
```

安装器分别管理 `lumen-terminal.service`（认证、HTTP、WebSocket）和
`lumen-pty.service`（PTY、shell、Codex）。正常更新只重启前者；
浏览器会自动重连，后者及其中的任务不会中断。因此可以从 Lumen 内运行
Codex 修改并重新安装 Lumen，而不需要依赖 Codex 的恢复功能。
显式重启 `lumen-pty.service` 也不会结束其中的程序；新进程会重新发现 tmux
中的 Lumen 会话。只有在界面结束会话、shell 自行退出或主动清理 tmux 会话时
才会终止任务。

从旧 tmux 架构首次迁移时，安装器会先启动新的 PTY supervisor，同时保留
旧服务，避免杀掉其中仍在运行的任务。验证新终端后，从 SSH/控制台执行一次：

```bash
sudo ./scripts/install.sh ubuntu terminal.example.com \
  --listen lo \
  --port 7681 \
  --client-ip-header X-Real-IP \
  --allow-sudo \
  --replace-legacy-sessions
```

这个参数会停止并移除旧 tmux service，只用于一次性清理；后续更新不要再使用。

首次安装会生成账号同名、随机密码的 session 策略，并只显示一次密码。
实际 shell 以该非 root Linux 用户运行；网页登录账号与 Linux 用户可以
不同。`--allow-sudo` 会为 shell 用户安装显式的 `NOPASSWD: ALL` 规则，
因此 `sudo <command>` 和 `sudo -i` 都无需再次输入密码。网页登录凭据一旦
泄露也将意味着完整 root 权限，应只在确实需要时启用。

监听地址、端口、最大连接数和认证配置路径保存在
`/etc/lumen-terminal/runtime.env`，无需修改 systemd 单元。仓库中的
`deploy/README.md` 给出了回环代理、环境自有端口转发和可信内网直连三种
部署；OpenResty/nginx 示例位于 `deploy/openresty-terminal.conf`。

## 会话操作

列出持久 PTY 会话：

```bash
LUMEN_PTY_SOCKET="$HOME/.local/state/lumen-terminal/pty.sock" \
  /opt/lumen-terminal/bin/lumen-pty --list
```

从 SSH/Mosh 接入同一会话：

```bash
LUMEN_PTY_SOCKET="$HOME/.local/state/lumen-terminal/pty.sock" \
  /opt/lumen-terminal/bin/lumen-pty main
```

标签上的 `×` 会询问是仅断开，还是结束 PTY 会话及其中全部程序。也可以
从命令行真正终止某个会话：

```bash
LUMEN_PTY_SOCKET="$HOME/.local/state/lumen-terminal/pty.sock" \
  /opt/lumen-terminal/bin/lumen-pty --kill term-2
```

## 鼠标与剪贴板

浏览器现在直连真实 PTY 字节流，中间没有第二层终端模拟器：

- 普通 shell 中拖动由 xterm.js 选取；松开后保留选区和滚动位置，不会跳回底部。
- TUI 正在接收鼠标时，按住 `Shift` 拖动可强制使用浏览器终端选区；
  macOS 也可按住 `Option` 拖动。
- 鼠标松开并完成选取时会自动复制；也可使用 `Ctrl+Shift+C`，macOS
  使用 `Cmd+C` 再次复制当前选区。
- 粘贴使用 `Ctrl+Shift+V`，macOS 使用 `Cmd+V`；xterm.js 会保留
  bracketed paste 保护。
- 鼠标选区与复制内容共用同一套逐行范围：真实行尾的 Unicode 空白不会
  高亮或进入剪贴板，常见的两列展示边距会在多行选区中自动移除；视觉
  自动换行仍会正确拼接，因此 Codex 输出的多行命令可以直接粘贴执行。
- 普通 shell 中右键保留浏览器的复制/粘贴菜单；若 TUI 主动接管鼠标，
  右键会和其他鼠标事件一样交给该程序。

剪贴板桥接只实现“终端写入客户端剪贴板”，不会把客户端已有剪贴板内容
返回给服务器中的程序；单次复制上限为 1 MiB。若浏览器阻止后台写入，
界面会显示一次明确的“点击复制”回退操作。服务器端的
`xclip`、`xsel` 或 `pbcopy` 不会用于此流程，因为它们操作
的是部署主机而不是远程浏览器所在设备。

## 终端颜色兼容

- xterm.js 会原生响应 OSC 10/11 前景色与背景色查询，Codex 等 TUI
  因而可以按 Lumen 当前的深浅主题选择自己的语义色。
- 手动切换 Lumen 主题后，焦点会回到当前终端，促使正在运行的 TUI
  重新探测颜色并重绘。
- 粗体只改变字重，不再隐式切换到高亮 ANSI 色；这与 Ghostty、iTerm2
  等现代终端的常见设置一致，也避免输入栏和状态栏颜色过饱和。
- 浅色模式为终端文字启用 4.5:1 的最低对比度保护。它只在某个前景色
  确实难以阅读时调整显示色，不改变程序输出的内容或背景结构。

Codex 的 `/theme` 只选择代码语法高亮主题；输入栏等主界面颜色仍由终端
默认色决定。通常建议不要在 `~/.codex/config.toml` 中固定
`tui.theme`，让 Codex 根据 Lumen 的背景自动选择 Catppuccin Latte
或 Mocha。若固定主题，应让浅色 Lumen 搭配浅色语法主题、深色 Lumen
搭配深色语法主题。

## 资源与系统隔离

- 最多 16 个持久标签，可通过 `--max-sessions` 调整；并发连接上限默认同为 16。
- 闲置标签不会预先创建；常规 UI 按需使用 `main`、`term-2` 至 `term-16`。
- 浏览器保留 5,000 行 scrollback；supervisor 为每个会话保留 2 MiB
  原始输出用于重连，可用 `--history-bytes` 和 `--max-sessions` 调整。
- 没有客户端时 supervisor 仍持续排空 PTY，避免后台任务被输出阻塞；
  其本身没有 Node、数据库、容器或终端渲染器。
- 前端在大量输出时会暂停 PTY 读取，等 xterm.js 消化后恢复。
- WebGL 不可用或上下文丢失时自动退回 xterm.js DOM 渲染。
- 认证进程读取 root-only 配置后永久降权到 shell 用户；基础部署允许
  `sudo`/setuid 提权。若某个环境不需要 root，可把
  `deploy/no-root-hardening.conf` 安装为 systemd drop-in，恢复
  `NoNewPrivileges` 和文件系统/内核沙箱。
- 使用系统字体，避免传输和常驻完整 CJK Web Font。

终端中的命令、编辑器和语言服务仍可能占用大量资源；这些不属于 Lumen
传输层开销。

## 上游与许可

后端基于 MIT 许可的 [ttyd](https://github.com/tsl0922/ttyd)，并加入
应用层延迟探针和内置 session 认证。浏览器终端使用 MIT 许可的 xterm.js
及其 Fit、WebGL、Web Links addons；各许可证保存在 `web/vendor/`。
