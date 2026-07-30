(() => {
  'use strict';

  const STORAGE_KEY = 'lumen.tabs.v1';
  const THEME_KEY = 'lumen.theme.v1';
  const MAX_TABS = 16;
  const FLOW_LIMIT = 100000;
  const FLOW_HIGH_WATER = 10;
  const FLOW_LOW_WATER = 4;
  const MAX_CLIPBOARD_BYTES = 1024 * 1024;
  const MAX_CLIPBOARD_BASE64 = Math.ceil(MAX_CLIPBOARD_BYTES / 3) * 4;
  const TERM_MINIMUM_CONTRAST = {
    dark: 1,
    light: 4.5,
  };

  const COMMAND = {
    OUTPUT: '0',
    SET_TITLE: '1',
    SET_PREFERENCES: '2',
    PONG: '3',
    INPUT: '0',
    RESIZE: '1',
    PAUSE: '2',
    RESUME: '3',
    PING: '4',
  };

  const TERM_THEMES = {
    dark: {
      background: '#10111a',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#10111a',
      selectionBackground: '#3b3d55',
      selectionForeground: '#cdd6f4',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#cba6f7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8',
    },
    light: {
      background: '#eff1f5',
      foreground: '#4c4f69',
      cursor: '#dc8a78',
      cursorAccent: '#eff1f5',
      selectionBackground: '#acb0be',
      selectionForeground: '#4c4f69',
      black: '#5c5f77',
      red: '#d20f39',
      green: '#40a02b',
      yellow: '#df8e1d',
      blue: '#1e66f5',
      magenta: '#ea76cb',
      cyan: '#179299',
      white: '#acb0be',
      brightBlack: '#6c6f85',
      brightRed: '#d20f39',
      brightGreen: '#40a02b',
      brightYellow: '#df8e1d',
      brightBlue: '#1e66f5',
      brightMagenta: '#8839ef',
      brightCyan: '#179299',
      brightWhite: '#bcc0cc',
    },
  };

  const KEY_SEQUENCES = {
    Escape: '\x1b',
    Tab: '\t',
    ArrowUp: '\x1b[A',
    ArrowDown: '\x1b[B',
    ArrowRight: '\x1b[C',
    ArrowLeft: '\x1b[D',
  };

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const sessions = new Map();
  const tabList = document.getElementById('tab-list');
  const stage = document.getElementById('terminal-stage');
  const addButton = document.getElementById('add-tab');
  const themeButton = document.getElementById('theme-toggle');
  const toast = document.getElementById('toast');
  const toastMessage = document.getElementById('toast-message');
  const toastAction = document.getElementById('toast-action');
  const mobileKeys = document.getElementById('mobile-keys');
  const sessionDialog = document.getElementById('session-dialog');
  const sessionDialogName = document.getElementById('session-dialog-name');
  const sessionDetach = document.getElementById('session-detach');
  const sessionTerminate = document.getElementById('session-terminate');
  const sessionCancel = document.getElementById('session-cancel');
  const basePath = window.location.pathname.replace(/\/+$/, '');
  let activeId = null;
  let tokenPromise = null;
  let toastTimer = null;
  let pingSequence = 0;
  let mobileCtrl = false;
  let pendingCloseId = null;
  let sessionActionPending = false;
  const storedTheme = localStorage.getItem(THEME_KEY);
  const systemThemeQuery = window.matchMedia('(prefers-color-scheme: light)');
  let followsSystemTheme = storedTheme !== 'light' && storedTheme !== 'dark';
  let currentTheme = followsSystemTheme && systemThemeQuery.matches
    ? 'light'
    : storedTheme === 'light'
      ? 'light'
      : 'dark';

  function hideToast() {
    toast.classList.remove('is-visible', 'has-action');
    toastAction.hidden = true;
    toastAction.onclick = null;
  }

  function showToast(message, timeout = 2600, action = null) {
    toastMessage.textContent = message;
    toastAction.hidden = !action;
    toast.classList.toggle('has-action', Boolean(action));
    toastAction.textContent = action?.label || '';
    toastAction.onclick = action?.handler || null;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    if (timeout > 0) toastTimer = setTimeout(hideToast, timeout);
  }

  function copyWithSelection(text) {
    const input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.append(input);
    input.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } finally {
      input.remove();
      sessions.get(activeId)?.term.focus();
    }
    return copied;
  }

  async function retryClipboardWrite(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (!copyWithSelection(text)) {
        throw new Error('clipboard API unavailable');
      }
      showToast('已复制到系统剪贴板');
    } catch (error) {
      console.warn('[lumen] clipboard write was denied', error);
      showToast('仍无法写入剪贴板，请检查此站点的剪贴板权限', 5200);
    }
  }

  function offerClipboardRetry(text) {
    showToast('浏览器阻止了自动复制', 12000, {
      label: '点击复制',
      handler: () => retryClipboardWrite(text),
    });
  }

  function normalizeTerminalSelection(text) {
    // xterm already joins visually wrapped rows. Removing only whitespace at
    // actual line boundaries keeps copied commands paste-ready without the
    // rectangular padding commonly introduced by terminal multiplexers.
    return text
      .split('\n')
      .map(line => line.replace(/[ \t]+(?=\r?$)/, ''))
      .join('\n');
  }

  async function writeSystemClipboard(text, announce = false, allowLegacy = false) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (allowLegacy && copyWithSelection(text)) {
        // The legacy path only runs directly inside a keyboard gesture.
      } else {
        offerClipboardRetry(text);
        return;
      }
      if (announce) showToast('已复制到系统剪贴板');
    } catch (error) {
      console.warn('[lumen] clipboard write was denied', error);
      offerClipboardRetry(text);
    }
  }

  function decodeOsc52(payload) {
    if (payload.length > MAX_CLIPBOARD_BASE64) {
      throw new RangeError('clipboard payload is too large');
    }
    const binary = atob(payload);
    if (binary.length > MAX_CLIPBOARD_BYTES) {
      throw new RangeError('clipboard payload is too large');
    }
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return decoder.decode(bytes);
  }

  function registerWriteOnlyClipboard(term) {
    return term.parser.registerOscHandler(52, data => {
      const separator = data.indexOf(';');
      if (separator < 0) return true;
      const payload = data.slice(separator + 1);

      // Never return the browser clipboard to a process running in the PTY.
      if (payload === '?') {
        console.warn('[lumen] ignored an OSC 52 clipboard read request');
        return true;
      }

      try {
        const text = decodeOsc52(payload);
        void writeSystemClipboard(text);
      } catch (error) {
        console.warn('[lumen] rejected an invalid OSC 52 clipboard payload', error);
        showToast(error instanceof RangeError
          ? '复制内容超过 1 MiB 安全上限'
          : '终端发送了无效的剪贴板数据', 4200);
      }
      return true;
    });
  }

  function terminalOptions() {
    return {
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      cursorStyle: 'bar',
      cursorWidth: 1,
      // Modern terminal apps use bold as typography. Mapping it to ANSI
      // bright colors changes semantic TUI palettes (notably Codex).
      drawBoldTextInBrightColors: false,
      fastScrollModifier: 'alt',
      fontFamily: '"SFMono-Regular", "SF Mono", "Cascadia Code", "JetBrains Mono", "Maple Mono NF CN", "Maple Mono NF", "Noto Sans Mono CJK SC", Menlo, Consolas, monospace',
      fontSize: window.matchMedia('(max-width: 560px)').matches ? 13 : 14,
      fontWeight: '400',
      fontWeightBold: '600',
      letterSpacing: 0.1,
      lineHeight: 1.22,
      macOptionClickForcesSelection: true,
      macOptionIsMeta: true,
      minimumContrastRatio: TERM_MINIMUM_CONTRAST[currentTheme],
      rightClickSelectsWord: true,
      scrollback: 5000,
      smoothScrollDuration: 0,
      theme: TERM_THEMES[currentTheme],
    };
  }

  function saveState() {
    const tabs = [...sessions.values()].map(session => ({
      id: session.id,
      name: session.name,
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs, activeId }));
  }

  function loadState() {
    try {
      const state = JSON.parse(localStorage.getItem(STORAGE_KEY));
      const validTabs = Array.isArray(state?.tabs)
        ? state.tabs
            .filter(tab => /^[a-z0-9][a-z0-9-]{0,31}$/.test(tab.id))
            .slice(0, MAX_TABS)
            .map(tab => ({
              id: tab.id,
              name: String(tab.name || tab.id).slice(0, 32),
            }))
        : [];
      if (validTabs.length) {
        return {
          tabs: validTabs,
          activeId: validTabs.some(tab => tab.id === state.activeId) ? state.activeId : validTabs[0].id,
        };
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    return { tabs: [{ id: 'main', name: 'main' }], activeId: 'main' };
  }

  function nextTab() {
    for (let number = 2; number <= MAX_TABS + 1; number += 1) {
      const id = `term-${number}`;
      if (!sessions.has(id)) return { id, name: `term ${number}` };
    }
    return null;
  }

  async function getToken() {
    if (!tokenPromise) {
      tokenPromise = fetch(`${basePath}/token`, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
        .then(response => {
          if (response.status === 401 || response.redirected) {
            window.location.assign(`${basePath}/login`);
            throw new Error('authentication required');
          }
          if (!response.ok) throw new Error(`token endpoint returned ${response.status}`);
          return response.json();
        })
        .then(data => data.token || '')
        .catch(error => {
          tokenPromise = null;
          throw error;
        });
    }
    return tokenPromise;
  }

  function websocketUrl(id) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${basePath}/ws?arg=${encodeURIComponent(id)}`;
  }

  function setConnectionState(session, state) {
    session.state = state;
    session.tab.dataset.state = state;
    session.tab.setAttribute(
      'aria-label',
      `${session.name}，${state === 'online' ? '已连接' : state === 'connecting' ? '正在连接' : '离线'}`,
    );
    if (state !== 'online') {
      session.latency.textContent = state === 'connecting' ? '···' : '—';
      session.latency.dataset.quality = '';
      session.latency.title = state === 'connecting' ? '正在连接' : '连接已断开';
      session.pendingPing = null;
    }
  }

  function setLatency(session, milliseconds) {
    session.lastLatency = milliseconds;
    session.smoothedLatency = session.smoothedLatency == null
      ? milliseconds
      : session.smoothedLatency * 0.72 + milliseconds * 0.28;
    session.latency.textContent = `${Math.round(milliseconds)} ms`;
    session.latency.dataset.quality = session.smoothedLatency < 80
      ? 'good'
      : session.smoothedLatency < 180
        ? 'fair'
        : 'poor';
    session.latency.title = `当前 ${Math.round(milliseconds)} ms · 平滑 ${Math.round(session.smoothedLatency)} ms`;
    session.tab.setAttribute(
      'aria-label',
      `${session.name}，已连接，延迟 ${Math.round(milliseconds)} 毫秒`,
    );
  }

  function sendBytes(session, command, data = new Uint8Array()) {
    if (session.socket?.readyState !== WebSocket.OPEN) return false;
    const body = typeof data === 'string' ? encoder.encode(data) : data;
    const payload = new Uint8Array(body.length + 1);
    payload[0] = command.charCodeAt(0);
    payload.set(body, 1);
    session.socket.send(payload);
    return true;
  }

  function sendInput(session, data) {
    if (mobileCtrl && typeof data === 'string' && data.length > 0) {
      const code = data.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) {
        data = String.fromCharCode(code - 64) + data.slice(1);
        setMobileCtrl(false);
      }
    }
    sendBytes(session, COMMAND.INPUT, typeof data === 'string' ? encoder.encode(data) : data);
  }

  function sendResize(session) {
    if (!session.fitAddon || session.destroyed) return;
    try {
      session.fitAddon.fit();
      const message = JSON.stringify({
        columns: session.term.cols,
        rows: session.term.rows,
      });
      sendBytes(session, COMMAND.RESIZE, message);
    } catch {
      // A hidden or transitioning terminal can briefly have zero dimensions.
    }
  }

  function scheduleResize(session) {
    clearTimeout(session.resizeTimer);
    session.resizeTimer = setTimeout(() => sendResize(session), 80);
  }

  function writeOutput(session, data) {
    session.bytesSinceDrain += data.byteLength;
    if (session.bytesSinceDrain < FLOW_LIMIT) {
      session.term.write(data);
      return;
    }

    session.bytesSinceDrain = 0;
    session.pendingWrites += 1;
    session.term.write(data, () => {
      session.pendingWrites = Math.max(0, session.pendingWrites - 1);
      if (session.flowPaused && session.pendingWrites < FLOW_LOW_WATER) {
        session.flowPaused = false;
        sendBytes(session, COMMAND.RESUME);
      }
    });

    if (!session.flowPaused && session.pendingWrites > FLOW_HIGH_WATER) {
      session.flowPaused = true;
      sendBytes(session, COMMAND.PAUSE);
    }
  }

  function handleSocketMessage(session, event) {
    const raw = new Uint8Array(event.data);
    if (!raw.length) return;
    const command = String.fromCharCode(raw[0]);
    const data = raw.subarray(1);

    switch (command) {
      case COMMAND.OUTPUT:
        writeOutput(session, data);
        break;
      case COMMAND.SET_TITLE: {
        const title = decoder.decode(data).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
        session.remoteTitle = title;
        session.tab.title = title || session.name;
        if (session.id === activeId && title) document.title = `${session.name} — Lumen`;
        break;
      }
      case COMMAND.SET_PREFERENCES:
        // The UI intentionally owns its small, fixed option set.
        break;
      case COMMAND.PONG: {
        const token = decoder.decode(data);
        if (session.pendingPing?.token === token) {
          const rtt = performance.now() - session.pendingPing.startedAt;
          session.pendingPing = null;
          setLatency(session, rtt);
        }
        break;
      }
      default:
        console.warn(`[lumen] unknown server command ${command}`);
    }
  }

  async function connect(session) {
    if (session.destroyed) return;
    clearTimeout(session.reconnectTimer);
    if (session.socket && session.socket.readyState < WebSocket.CLOSING) session.socket.close();
    setConnectionState(session, 'connecting');

    let token = '';
    try {
      token = await getToken();
    } catch (error) {
      setConnectionState(session, 'offline');
      session.reconnectAttempts += 1;
      if (session.reconnectAttempts === 2) showToast('无法验证访问身份，请检查安全入口');
      scheduleReconnect(session);
      return;
    }

    if (session.destroyed) return;
    const socket = new WebSocket(websocketUrl(session.id), ['tty']);
    session.socket = socket;
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', () => {
      if (session.destroyed || socket !== session.socket) return;
      session.reconnectAttempts = 0;
      setConnectionState(session, 'online');
      const init = JSON.stringify({
        AuthToken: token,
        columns: session.term.cols,
        rows: session.term.rows,
      });
      socket.send(encoder.encode(init));
      scheduleResize(session);
      if (session.id === activeId) session.term.focus();
    });

    socket.addEventListener('message', event => {
      if (socket === session.socket && event.data instanceof ArrayBuffer) {
        handleSocketMessage(session, event);
      }
    });

    socket.addEventListener('close', () => {
      if (session.destroyed || socket !== session.socket) return;
      setConnectionState(session, 'offline');
      session.reconnectAttempts += 1;
      scheduleReconnect(session);
    });

    socket.addEventListener('error', () => {
      if (socket === session.socket) socket.close();
    });
  }

  function scheduleReconnect(session) {
    if (session.destroyed) return;
    const delay = Math.min(8000, 500 * (2 ** Math.min(session.reconnectAttempts, 4)));
    const jitter = Math.round(Math.random() * 250);
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = setTimeout(() => connect(session), delay + jitter);
  }

  function pingSession(session, now) {
    if (session.state !== 'online' || session.socket?.readyState !== WebSocket.OPEN) return;
    const interval = document.hidden ? 5000 : 1000;
    if (now - session.lastPingAt < interval) return;

    if (session.pendingPing) {
      if (now - session.pendingPing.startedAt < 4500) return;
      session.pendingPing = null;
      session.latency.textContent = '超时';
      session.latency.dataset.quality = 'poor';
    }

    const token = (++pingSequence).toString(36);
    session.pendingPing = { token, startedAt: performance.now() };
    session.lastPingAt = now;
    sendBytes(session, COMMAND.PING, token);
  }

  function makeTab(session) {
    const tab = document.createElement('div');
    tab.className = 'terminal-tab';
    tab.id = `tab-${session.id}`;
    tab.dataset.state = 'connecting';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('tabindex', '-1');
    tab.setAttribute('aria-controls', `pane-${session.id}`);
    tab.setAttribute('aria-selected', 'false');

    const dot = document.createElement('span');
    dot.className = 'connection-dot';
    dot.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = session.name;

    const latency = document.createElement('span');
    latency.className = 'latency';
    latency.textContent = '···';

    const close = document.createElement('button');
    close.className = 'close-tab';
    close.type = 'button';
    close.title = '关闭或结束终端';
    close.setAttribute('aria-label', `关闭或结束 ${session.name}`);
    close.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9"/></svg>';

    tab.append(dot, name, latency, close);
    tab.addEventListener('click', event => {
      if (!event.target.closest('.close-tab')) activateSession(session.id);
    });
    tab.addEventListener('dblclick', event => {
      if (event.target.closest('.tab-name')) beginRename(session);
    });
    tab.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateSession(session.id);
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        const ordered = [...sessions.keys()];
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const index = (ordered.indexOf(session.id) + direction + ordered.length) % ordered.length;
        activateSession(ordered[index]);
      }
    });
    close.addEventListener('click', event => {
      event.stopPropagation();
      openSessionDialog(session.id);
    });

    session.tab = tab;
    session.nameNode = name;
    session.latency = latency;
    return tab;
  }

  function beginRename(session) {
    if (session.nameNode.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'tab-name-input';
    input.value = session.name;
    input.maxLength = 32;
    session.nameNode.textContent = '';
    session.nameNode.append(input);
    input.focus();
    input.select();

    const finish = save => {
      if (!input.isConnected) return;
      const nextName = input.value.trim().slice(0, 32);
      if (save && nextName) session.name = nextName;
      session.nameNode.textContent = session.name;
      session.tab.querySelector('.close-tab').setAttribute('aria-label', `关闭或结束 ${session.name}`);
      session.tab.setAttribute(
        'aria-label',
        `${session.name}，${session.state === 'online' ? '已连接' : session.state === 'connecting' ? '正在连接' : '离线'}`,
      );
      if (session.id === activeId) document.title = `${session.name} — Lumen`;
      saveState();
      session.term.focus();
    };

    input.addEventListener('blur', () => finish(true), { once: true });
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') input.blur();
      if (event.key === 'Escape') {
        input.value = session.name;
        input.blur();
      }
    });
  }

  function createSession(meta, activate = true) {
    if (sessions.has(meta.id) || sessions.size >= MAX_TABS) return sessions.get(meta.id);

    const session = {
      id: meta.id,
      name: meta.name,
      state: 'connecting',
      socket: null,
      tab: null,
      pane: null,
      term: null,
      fitAddon: null,
      webglAddon: null,
      clipboardDisposable: null,
      copyListener: null,
      destroyed: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
      resizeTimer: null,
      pendingPing: null,
      lastPingAt: 0,
      lastLatency: null,
      smoothedLatency: null,
      bytesSinceDrain: 0,
      pendingWrites: 0,
      flowPaused: false,
      remoteTitle: '',
    };

    session.tab = makeTab(session);
    tabList.append(session.tab);

    const pane = document.createElement('section');
    pane.className = 'terminal-pane';
    pane.id = `pane-${session.id}`;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', session.tab.id);
    pane.setAttribute('aria-hidden', 'true');
    const mount = document.createElement('div');
    mount.className = 'terminal-mount';
    pane.append(mount);
    stage.append(pane);
    session.pane = pane;

    const term = new Terminal(terminalOptions());
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon.WebLinksAddon((event, uri) => {
      if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
    }));
    term.open(mount);
    session.clipboardDisposable = registerWriteOnlyClipboard(term);
    session.copyListener = event => {
      if (!term.hasSelection() || !event.clipboardData) return;
      event.clipboardData.setData(
        'text/plain',
        normalizeTerminalSelection(term.getSelection()),
      );
      event.preventDefault();
    };
    mount.addEventListener('copy', session.copyListener, true);

    try {
      const webglAddon = new WebglAddon.WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
        session.webglAddon = null;
      });
      term.loadAddon(webglAddon);
      session.webglAddon = webglAddon;
    } catch (error) {
      console.info('[lumen] WebGL renderer unavailable; using DOM renderer', error);
    }

    session.term = term;
    session.fitAddon = fitAddon;
    sessions.set(session.id, session);

    term.onData(data => sendInput(session, data));
    term.onBinary(data => sendInput(session, Uint8Array.from(data, character => character.charCodeAt(0))));
    term.onResize(() => {
      if (session.id === activeId) scheduleResize(session);
    });
    term.attachCustomKeyEventHandler(event => {
      const copy = (event.ctrlKey && event.shiftKey && event.code === 'KeyC')
        || (event.metaKey && event.code === 'KeyC');
      const paste = (event.ctrlKey && event.shiftKey && event.code === 'KeyV')
        || (event.metaKey && event.code === 'KeyV');
      if (copy) {
        event.preventDefault();
        if (event.type === 'keydown') {
          if (term.hasSelection()) {
            void writeSystemClipboard(
              normalizeTerminalSelection(term.getSelection()),
              true,
              true,
            );
          } else {
            showToast('没有选中的文本');
          }
        }
        return false;
      }
      if (paste) {
        // Do not prevent the browser default: xterm.js consumes the resulting
        // paste event and applies bracketed paste before sending it to the PTY.
        return false;
      }
      if (event.ctrlKey && !event.shiftKey && event.code === 'KeyW') {
        event.preventDefault();
        if (event.type === 'keydown') sendInput(session, '\x17');
        return false;
      }
      return true;
    });

    requestAnimationFrame(() => {
      if (activate) activateSession(session.id);
      scheduleResize(session);
      connect(session);
    });
    saveState();
    return session;
  }

  function activateSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    activeId = id;

    for (const candidate of sessions.values()) {
      const active = candidate.id === id;
      candidate.tab.setAttribute('aria-selected', active ? 'true' : 'false');
      candidate.tab.setAttribute('tabindex', active ? '0' : '-1');
      candidate.pane.classList.toggle('is-active', active);
      candidate.pane.setAttribute('aria-hidden', active ? 'false' : 'true');
    }

    document.title = `${session.name} — Lumen`;
    session.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    requestAnimationFrame(() => {
      scheduleResize(session);
      session.term.focus();
    });
    saveState();
  }

  function detachSession(id, message = '标签已关闭，后台 PTY 会话仍在运行') {
    if (sessions.size === 1) {
      showToast('至少保留一个终端标签');
      return;
    }
    const ordered = [...sessions.keys()];
    const index = ordered.indexOf(id);
    const session = sessions.get(id);
    if (!session) return;

    session.destroyed = true;
    clearTimeout(session.reconnectTimer);
    clearTimeout(session.resizeTimer);
    if (session.socket && session.socket.readyState < WebSocket.CLOSING) session.socket.close(1000, 'tab closed');
    session.clipboardDisposable?.dispose();
    if (session.copyListener) {
      session.pane.querySelector('.terminal-mount')
        ?.removeEventListener('copy', session.copyListener, true);
    }
    session.webglAddon?.dispose();
    session.term.dispose();
    session.tab.remove();
    session.pane.remove();
    sessions.delete(id);

    if (activeId === id) {
      const remaining = [...sessions.keys()];
      activateSession(remaining[Math.min(index, remaining.length - 1)]);
    }
    saveState();
    showToast(message);
  }

  function openSessionDialog(id) {
    const session = sessions.get(id);
    if (!session || sessionActionPending) return;
    pendingCloseId = id;
    sessionDialogName.textContent = session.name;
    sessionDetach.disabled = sessions.size === 1;
    sessionDetach.title = sessions.size === 1 ? '界面至少保留一个标签' : '';
    sessionDialog.showModal();
    requestAnimationFrame(() => (sessions.size === 1 ? sessionTerminate : sessionDetach).focus());
  }

  function closeSessionDialog() {
    if (sessionActionPending) return;
    sessionDialog.close();
    pendingCloseId = null;
  }

  async function terminateSession(id) {
    const session = sessions.get(id);
    if (!session || sessionActionPending) return;
    sessionActionPending = true;
    const label = sessionTerminate.querySelector('span');
    const originalLabel = label.textContent;
    label.textContent = '正在结束…';
    sessionDetach.disabled = true;
    sessionTerminate.disabled = true;
    sessionCancel.disabled = true;

    try {
      const response = await fetch(`${basePath}/api/sessions/${encodeURIComponent(id)}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'X-Lumen-Action': 'terminate',
        },
      });
      if (response.status === 401 || response.redirected) {
        window.location.assign(`${basePath}/login`);
        return;
      }
      if (!response.ok && response.status !== 404) {
        throw new Error(`terminate endpoint returned ${response.status}`);
      }

      sessionDialog.close();
      pendingCloseId = null;
      if (sessions.size > 1) {
        detachSession(id, '终端会话及其中程序已结束');
      } else {
        session.term.reset();
        session.reconnectAttempts = 0;
        setConnectionState(session, 'connecting');
        if (session.socket && session.socket.readyState < WebSocket.CLOSING) {
          session.socket.close(1000, 'session terminated');
        }
        scheduleReconnect(session);
        showToast('原会话已结束，正在创建新的空终端');
      }
    } catch (error) {
      console.error('[lumen] failed to terminate session', error);
      showToast('无法结束会话，请稍后重试');
    } finally {
      sessionActionPending = false;
      label.textContent = originalLabel;
      sessionTerminate.disabled = false;
      sessionCancel.disabled = false;
      if (sessionDialog.open) sessionDetach.disabled = sessions.size === 1;
    }
  }

  function addSession() {
    if (sessions.size >= MAX_TABS) {
      showToast(`轻量模式最多同时打开 ${MAX_TABS} 个终端`);
      return;
    }
    const meta = nextTab();
    if (meta) createSession(meta, true);
  }

  function applyTheme(theme, persist = true, restoreTerminalFocus = false) {
    currentTheme = theme;
    document.documentElement.dataset.theme = theme;
    if (persist) localStorage.setItem(THEME_KEY, theme);
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#10111a' : '#eff1f5';
    const nextTheme = theme === 'dark' ? '浅色' : '深色';
    themeButton.title = `切换到${nextTheme}主题`;
    themeButton.setAttribute('aria-label', `切换到${nextTheme}主题`);
    for (const session of sessions.values()) {
      session.term.options.minimumContrastRatio = TERM_MINIMUM_CONTRAST[theme];
      session.term.options.theme = TERM_THEMES[theme];
      session.term.clearTextureAtlas?.();
    }

    // Codex and other TUIs query OSC 10/11 when focus returns so they can
    // rebuild light/dark semantic colors. xterm.js answers those queries from
    // the newly applied theme. Returning focus also keeps the toggle feeling
    // like a native terminal preference instead of leaving focus in chrome.
    if (restoreTerminalFocus) {
      requestAnimationFrame(() => {
        const session = sessions.get(activeId);
        if (!session?.destroyed) session.term.focus();
      });
    }
  }

  function setMobileCtrl(active) {
    mobileCtrl = active;
    mobileKeys.querySelector('[data-modifier="ctrl"]')?.classList.toggle('is-active', active);
  }

  addButton.addEventListener('click', addSession);
  themeButton.addEventListener('click', () => {
    followsSystemTheme = false;
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark', true, true);
  });
  tabList.addEventListener('wheel', event => {
    if (tabList.scrollWidth <= tabList.clientWidth) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    tabList.scrollLeft += event.deltaY;
  }, { passive: false });
  sessionDetach.addEventListener('click', () => {
    const id = pendingCloseId;
    closeSessionDialog();
    if (id) detachSession(id);
  });
  sessionTerminate.addEventListener('click', () => {
    if (pendingCloseId) terminateSession(pendingCloseId);
  });
  sessionCancel.addEventListener('click', closeSessionDialog);
  sessionDialog.addEventListener('cancel', event => {
    if (sessionActionPending) {
      event.preventDefault();
      return;
    }
    pendingCloseId = null;
  });
  sessionDialog.addEventListener('click', event => {
    if (event.target === sessionDialog) closeSessionDialog();
  });
  document.querySelector('.brand').addEventListener('click', event => {
    event.preventDefault();
    sessions.get(activeId)?.term.focus();
  });

  mobileKeys.addEventListener('pointerdown', event => event.preventDefault());
  mobileKeys.addEventListener('click', event => {
    const button = event.target.closest('button');
    const session = sessions.get(activeId);
    if (!button || !session) return;
    if (button.dataset.modifier === 'ctrl') {
      setMobileCtrl(!mobileCtrl);
    } else if (button.dataset.key) {
      sendInput(session, KEY_SEQUENCES[button.dataset.key] || '');
      session.term.focus();
    } else if (button.dataset.text) {
      sendInput(session, button.dataset.text);
      session.term.focus();
    }
  });

  const resizeObserver = new ResizeObserver(() => {
    const session = sessions.get(activeId);
    if (session) scheduleResize(session);
  });
  resizeObserver.observe(stage);

  window.addEventListener('keydown', event => {
    const newTabShortcut = (event.ctrlKey && event.shiftKey && event.code === 'KeyT')
      || (event.metaKey && !event.shiftKey && event.code === 'KeyT');
    if (newTabShortcut) {
      event.preventDefault();
      addSession();
    }
    if (event.metaKey && !event.shiftKey && event.code === 'KeyW') {
      event.preventDefault();
      if (activeId) openSessionDialog(activeId);
    }
    if (event.metaKey && !event.shiftKey && /^Digit[1-9]$/.test(event.code)) {
      const index = Number(event.code.slice(-1)) - 1;
      const id = [...sessions.keys()][index];
      if (id) {
        event.preventDefault();
        activateSession(id);
      }
    }
    if (event.metaKey && event.shiftKey
      && (event.code === 'BracketLeft' || event.code === 'BracketRight')
      && sessions.size > 1) {
      event.preventDefault();
      const ordered = [...sessions.keys()];
      const direction = event.code === 'BracketRight' ? 1 : -1;
      const index = (ordered.indexOf(activeId) + direction + ordered.length) % ordered.length;
      activateSession(ordered[index]);
    }
    if (event.ctrlKey && event.code === 'Tab' && sessions.size > 1) {
      event.preventDefault();
      const ordered = [...sessions.keys()];
      const direction = event.shiftKey ? -1 : 1;
      const index = (ordered.indexOf(activeId) + direction + ordered.length) % ordered.length;
      activateSession(ordered[index]);
    }
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      const now = performance.now();
      for (const session of sessions.values()) session.lastPingAt = now - 1000;
    }
  });

  setInterval(() => {
    const now = performance.now();
    for (const session of sessions.values()) pingSession(session, now);
  }, 500);

  systemThemeQuery.addEventListener?.('change', event => {
    if (followsSystemTheme) applyTheme(event.matches ? 'light' : 'dark', false);
  });

  applyTheme(currentTheme, false);
  const restored = loadState();
  restored.tabs.forEach(tab => createSession(tab, false));
  activateSession(restored.activeId);
})();
