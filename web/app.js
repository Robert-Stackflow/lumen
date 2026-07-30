(() => {
  'use strict';

  const STORAGE_KEY = 'lumen.tabs.v1';
  const THEME_KEY = 'lumen.theme.v1';
  const SETTINGS_KEY = 'lumen.settings.v1';
  const MAX_TABS = 16;
  const FLOW_LIMIT = 100000;
  const FLOW_HIGH_WATER = 10;
  const FLOW_LOW_WATER = 4;
  const MAX_CLIPBOARD_BYTES = 1024 * 1024;
  const MAX_CLIPBOARD_BASE64 = Math.ceil(MAX_CLIPBOARD_BYTES / 3) * 4;
  const {
    computeTerminalSelectionRanges,
    normalizeSelectionFromTerminal,
  } = globalThis.LumenSelection;
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
      selectionBackground: 'rgba(0, 0, 0, 0)',
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
      selectionBackground: 'rgba(0, 0, 0, 0)',
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
  const settingsButton = document.getElementById('settings-toggle');
  const settingsDialog = document.getElementById('settings-dialog');
  const copySelectionSetting = document.getElementById('setting-copy-selection');
  const closeBehaviorSetting = document.getElementById('setting-close-behavior');
  const fontSizeSetting = document.getElementById('setting-font-size');
  const fontSizeValue = document.getElementById('setting-font-size-value');
  const cursorStyleSetting = document.getElementById('setting-cursor-style');
  const cursorBlinkSetting = document.getElementById('setting-cursor-blink');
  const lineHeightSetting = document.getElementById('setting-line-height');
  const lineHeightValue = document.getElementById('setting-line-height-value');
  const workingDirectorySetting = document.getElementById('setting-working-directory');
  const protectRunningSetting = document.getElementById('setting-protect-running');
  const shortcutSearchSetting = document.getElementById('setting-shortcut-search');
  const shortcutNewTabSetting = document.getElementById('setting-shortcut-new-tab');
  const openSessionManagerButton = document.getElementById('open-session-manager');
  const exportTerminalButton = document.getElementById('export-terminal');
  const terminalSearch = document.getElementById('terminal-search');
  const terminalSearchInput = document.getElementById('terminal-search-input');
  const terminalSearchStatus = document.getElementById('terminal-search-status');
  const sessionManagerDialog = document.getElementById('session-manager-dialog');
  const sessionManagerList = document.getElementById('session-manager-list');
  const toast = document.getElementById('toast');
  const toastMessage = document.getElementById('toast-message');
  const toastAction = document.getElementById('toast-action');
  const mobileKeys = document.getElementById('mobile-keys');
  const sessionDialog = document.getElementById('session-dialog');
  const sessionDialogName = document.getElementById('session-dialog-name');
  const sessionDetach = document.getElementById('session-detach');
  const sessionTerminate = document.getElementById('session-terminate');
  const sessionCancel = document.getElementById('session-cancel');
  const tabStrip = document.getElementById('tab-strip');
  const contextMenu = document.getElementById('context-menu');
  const basePath = window.location.pathname.replace(/\/+$/, '');
  let activeId = null;
  let tokenPromise = null;
  let toastTimer = null;
  let pingSequence = 0;
  let mobileCtrl = false;
  let pendingCloseId = null;
  let sessionActionPending = false;
  let contextMenuRestoreFocus = null;
  const defaultFontSize = window.matchMedia('(max-width: 560px)').matches ? 13 : 14;
  let settings = loadSettings();
  const storedTheme = localStorage.getItem(THEME_KEY);
  const systemThemeQuery = window.matchMedia('(prefers-color-scheme: light)');
  let followsSystemTheme = storedTheme !== 'light' && storedTheme !== 'dark';
  let currentTheme = followsSystemTheme && systemThemeQuery.matches
    ? 'light'
    : storedTheme === 'light'
      ? 'light'
      : 'dark';

  function loadSettings() {
    const defaults = {
      copySelection: true,
      closeBehavior: 'ask',
      fontSize: defaultFontSize,
      cursorStyle: 'bar',
      cursorBlink: true,
      lineHeight: 1.22,
      workingDirectory: '/home/ubuntu',
      protectRunning: true,
      shortcuts: { search: 'Ctrl+Shift+F', newTab: 'Ctrl+Shift+T' },
    };
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      return {
        copySelection: typeof saved?.copySelection === 'boolean'
          ? saved.copySelection
          : defaults.copySelection,
        closeBehavior: ['ask', 'detach', 'terminate'].includes(saved?.closeBehavior)
          ? saved.closeBehavior
          : defaults.closeBehavior,
        fontSize: Number.isInteger(saved?.fontSize) && saved.fontSize >= 11 && saved.fontSize <= 20
          ? saved.fontSize
          : defaults.fontSize,
        cursorStyle: ['bar', 'block', 'underline'].includes(saved?.cursorStyle)
          ? saved.cursorStyle : defaults.cursorStyle,
        cursorBlink: typeof saved?.cursorBlink === 'boolean' ? saved.cursorBlink : defaults.cursorBlink,
        lineHeight: Number(saved?.lineHeight) >= 1 && Number(saved?.lineHeight) <= 1.6
          ? Number(saved.lineHeight) : defaults.lineHeight,
        workingDirectory: typeof saved?.workingDirectory === 'string'
          ? saved.workingDirectory.slice(0, 240) : defaults.workingDirectory,
        protectRunning: typeof saved?.protectRunning === 'boolean'
          ? saved.protectRunning : defaults.protectRunning,
        shortcuts: {
          search: saved?.shortcuts?.search || defaults.shortcuts.search,
          newTab: saved?.shortcuts?.newTab || defaults.shortcuts.newTab,
        },
      };
    } catch {
      localStorage.removeItem(SETTINGS_KEY);
      return defaults;
    }
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function setCustomSelect(control, value, notify = false) {
    const option = control.querySelector(`[data-value="${CSS.escape(value)}"]`);
    if (!option) return;
    control.dataset.value = value;
    control.querySelector('.custom-select-trigger span').textContent = option.textContent;
    for (const candidate of control.querySelectorAll('[role="option"]')) {
      const selected = candidate.dataset.value === value;
      candidate.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
    if (notify) control.dispatchEvent(new Event('change'));
  }

  function closeCustomSelect(control) {
    const menu = control.querySelector('.custom-select-menu');
    const trigger = control.querySelector('.custom-select-trigger');
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    control.classList.remove('is-open');
  }

  function installCustomSelect(control) {
    const trigger = control.querySelector('.custom-select-trigger');
    const menu = control.querySelector('.custom-select-menu');
    trigger.addEventListener('click', () => {
      const opening = menu.hidden;
      for (const other of document.querySelectorAll('.custom-select.is-open')) closeCustomSelect(other);
      if (opening) {
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        control.classList.add('is-open');
        menu.querySelector('[aria-selected="true"]')?.focus();
      }
    });
    menu.addEventListener('click', event => {
      const option = event.target.closest('[data-value]');
      if (!option) return;
      setCustomSelect(control, option.dataset.value, true);
      closeCustomSelect(control);
      trigger.focus();
    });
    control.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        closeCustomSelect(control);
        trigger.focus();
      }
    });
  }

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

  const MENU_ICONS = {
    activate: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    rename: '<path d="m4 16-.5 4 4-.5L18 9l-3-3L4 16Zm9-8 3 3"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    paste: '<path d="M9 5h6M9 3h6v4H9z"/><path d="M7 5H5v16h14V5h-2"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
    select: '<path d="M7 3H3v4M17 3h4v4M7 21H3v-4M17 21h4v-4"/><path d="M8 9h8M8 13h8M8 17h5"/>',
    export: '<path d="M12 3v12m-4-4 4 4 4-4"/><path d="M5 19h14"/>',
    clear: '<path d="m4 15 8-11 8 11-5 5H9l-5-5Z"/><path d="m8 14 5 5"/>',
    add: '<path d="M12 5v14M5 12h14"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12h2M3 12h2M12 3v2m0 14v2M17 7l1.5-1.5M5.5 18.5 7 17m10 0 1.5 1.5M5.5 5.5 7 7"/>',
    sessions: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    close: '<path d="m7 7 10 10M17 7 7 17"/>',
    terminate: '<path d="M12 3v9"/><path d="M6.3 5.8a8 8 0 1 0 11.4 0"/>',
  };

  function hideContextMenu(restoreFocus = false) {
    if (contextMenu.hidden) return;
    contextMenu.hidden = true;
    contextMenu.replaceChildren();
    if (restoreFocus) contextMenuRestoreFocus?.();
    contextMenuRestoreFocus = null;
  }

  function showContextMenu(event, items, restoreFocus) {
    event.preventDefault();
    event.stopPropagation();
    hideContextMenu();
    contextMenuRestoreFocus = restoreFocus;

    for (const item of items) {
      if (item.separator) {
        const separator = document.createElement('div');
        separator.className = 'context-menu-separator';
        separator.setAttribute('role', 'separator');
        contextMenu.append(separator);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.disabled = Boolean(item.disabled);
      button.classList.toggle('danger', Boolean(item.danger));
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = MENU_ICONS[item.icon] || '';
      const label = document.createElement('span');
      label.textContent = item.label;
      const shortcut = document.createElement('kbd');
      shortcut.textContent = item.shortcut || '';
      button.append(icon, label, shortcut);
      button.addEventListener('click', () => {
        hideContextMenu();
        item.action?.();
      });
      contextMenu.append(button);
    }

    contextMenu.hidden = false;
    contextMenu.style.left = '0';
    contextMenu.style.top = '0';
    const rect = contextMenu.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(event.clientX, window.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(event.clientY, window.innerHeight - rect.height - margin));
    contextMenu.style.left = `${left}px`;
    contextMenu.style.top = `${top}px`;
    contextMenu.style.transformOrigin =
      `${event.clientX < left + rect.width / 2 ? 'left' : 'right'} `
      + `${event.clientY < top + rect.height / 2 ? 'top' : 'bottom'}`;
    contextMenu.querySelector('button:not(:disabled)')?.focus();
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

  function renderSelectionOverlay(session) {
    const { term, selectionLayer } = session;
    if (!term || !selectionLayer) return;

    if (!term.hasSelection()) {
      selectionLayer.replaceChildren();
      return;
    }

    const fragment = document.createDocumentFragment();
    const viewportY = term.buffer.active.viewportY;
    for (const range of computeTerminalSelectionRanges(term)) {
      const viewportRow = range.row - viewportY;
      if (viewportRow < 0 || viewportRow >= term.rows) continue;

      const segment = document.createElement('span');
      segment.className = 'terminal-selection-segment';
      segment.style.left = `${(range.start / term.cols) * 100}%`;
      segment.style.width = `${((range.end - range.start) / term.cols) * 100}%`;
      segment.style.top = `${(viewportRow / term.rows) * 100}%`;
      segment.style.height = `${100 / term.rows}%`;
      fragment.append(segment);
    }
    selectionLayer.replaceChildren(fragment);
  }

  function scheduleSelectionOverlay(session) {
    if (session.selectionRenderFrame !== null) return;
    session.selectionRenderFrame = requestAnimationFrame(() => {
      session.selectionRenderFrame = null;
      renderSelectionOverlay(session);
    });
  }

  function copyTerminalSelection(session) {
    if (!settings.copySelection) return;
    if (session.destroyed || !session.term.hasSelection()) return;
    const text = normalizeSelectionFromTerminal(session.term);
    if (text.length === 0) return;
    void writeSystemClipboard(text, false, true);
  }

  function installSelectionOverlay(session) {
    const screen = session.term.element?.querySelector('.xterm-screen');
    if (!screen) throw new Error('xterm screen was not created');

    const layer = document.createElement('div');
    layer.className = 'terminal-selection-layer';
    layer.setAttribute('aria-hidden', 'true');
    screen.append(layer);
    session.selectionLayer = layer;
    session.selectionDisposables.push(
      session.term.onSelectionChange(() => scheduleSelectionOverlay(session)),
      session.term.onScroll(() => scheduleSelectionOverlay(session)),
      session.term.onRender(() => scheduleSelectionOverlay(session)),
    );

    let pointerSelecting = false;
    const beginPointerSelection = event => {
      if (event.button !== 0) return;
      pointerSelecting = true;
      scheduleSelectionOverlay(session);
    };
    const updatePointerSelection = event => {
      if (!pointerSelecting) return;
      if (event.buttons === 0) {
        pointerSelecting = false;
        queueMicrotask(() => copyTerminalSelection(session));
      }
      scheduleSelectionOverlay(session);
    };
    const endPointerSelection = () => {
      if (!pointerSelecting) return;
      pointerSelecting = false;
      scheduleSelectionOverlay(session);
      // xterm finalizes double-click, triple-click, and drag selections later
      // in this pointerup dispatch. A microtask sees the completed range while
      // retaining the user activation needed by restrictive clipboard APIs.
      queueMicrotask(() => copyTerminalSelection(session));
    };
    const cancelPointerSelection = () => {
      if (!pointerSelecting) return;
      pointerSelecting = false;
      scheduleSelectionOverlay(session);
    };
    screen.addEventListener('pointerdown', beginPointerSelection, true);
    window.addEventListener('pointermove', updatePointerSelection, true);
    window.addEventListener('pointerup', endPointerSelection, true);
    window.addEventListener('pointercancel', cancelPointerSelection, true);
    session.selectionPointerCleanup = () => {
      screen.removeEventListener('pointerdown', beginPointerSelection, true);
      window.removeEventListener('pointermove', updatePointerSelection, true);
      window.removeEventListener('pointerup', endPointerSelection, true);
      window.removeEventListener('pointercancel', cancelPointerSelection, true);
    };
    scheduleSelectionOverlay(session);
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
      cursorBlink: settings.cursorBlink,
      cursorInactiveStyle: 'outline',
      cursorStyle: settings.cursorStyle,
      cursorWidth: 1,
      // Modern terminal apps use bold as typography. Mapping it to ANSI
      // bright colors changes semantic TUI palettes (notably Codex).
      drawBoldTextInBrightColors: false,
      fastScrollModifier: 'alt',
      fontFamily: '"SFMono-Regular", "SF Mono", "Cascadia Code", "JetBrains Mono", "Maple Mono NF CN", "Maple Mono NF", "Noto Sans Mono CJK SC", Menlo, Consolas, monospace',
      fontSize: settings.fontSize,
      fontWeight: '400',
      fontWeightBold: '600',
      letterSpacing: 0.1,
      lineHeight: settings.lineHeight,
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
      if (session.initialWorkingDirectory) {
        const directory = session.initialWorkingDirectory;
        session.initialWorkingDirectory = '';
        const quoted = directory.replace(/'/g, `'\\''`);
        setTimeout(() => {
          if (!session.destroyed && session.socket === socket) {
            sendInput(session, `cd -- '${quoted}'\r`);
          }
        }, 120);
      }
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
      if (event.target.closest('.close-tab, .tab-name-input')) return;
      event.preventDefault();
      requestCloseSession(session.id);
    });
    tab.addEventListener('contextmenu', event => {
      showContextMenu(event, tabContextItems(session), () => session.term.focus());
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
      requestCloseSession(session.id);
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
      selectionLayer: null,
      selectionDisposables: [],
      selectionRenderFrame: null,
      selectionPointerCleanup: null,
      initialWorkingDirectory: activate ? settings.workingDirectory.trim() : '',
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
        normalizeSelectionFromTerminal(term),
      );
      event.preventDefault();
    };
    mount.addEventListener('copy', session.copyListener, true);
    mount.addEventListener('contextmenu', event => {
      // Shift + right-click remains an escape hatch for the browser's native menu.
      if (event.shiftKey) return;
      activateSession(session.id);
      showContextMenu(event, terminalContextItems(session), () => session.term.focus());
    }, true);

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
    installSelectionOverlay(session);

    term.onData(data => sendInput(session, data));
    term.onBinary(data => sendInput(session, Uint8Array.from(data, character => character.charCodeAt(0))));
    term.onResize(() => {
      if (session.id === activeId) scheduleResize(session);
      scheduleSelectionOverlay(session);
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
              normalizeSelectionFromTerminal(term),
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
    hideContextMenu();
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
    for (const disposable of session.selectionDisposables) disposable.dispose();
    if (session.selectionRenderFrame !== null) {
      cancelAnimationFrame(session.selectionRenderFrame);
    }
    session.selectionPointerCleanup?.();
    session.selectionLayer?.remove();
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

  function requestCloseSession(id) {
    if (settings.closeBehavior === 'terminate' && !settings.protectRunning) {
      void terminateSession(id);
      return;
    }
    if (settings.closeBehavior === 'detach') {
      detachSession(id);
      return;
    }
    openSessionDialog(id);
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

      if (sessionDialog.open) sessionDialog.close();
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

  function applyFontSize(fontSize) {
    settings.fontSize = fontSize;
    fontSizeSetting.value = String(fontSize);
    fontSizeValue.value = `${fontSize}px`;
    for (const session of sessions.values()) {
      session.term.options.fontSize = fontSize;
      session.term.clearTextureAtlas?.();
      scheduleResize(session);
    }
  }

  function applyTerminalAppearance() {
    lineHeightValue.value = settings.lineHeight.toFixed(2);
    for (const session of sessions.values()) {
      session.term.options.cursorStyle = settings.cursorStyle;
      session.term.options.cursorBlink = settings.cursorBlink;
      session.term.options.lineHeight = settings.lineHeight;
      session.term.clearTextureAtlas?.();
      scheduleResize(session);
    }
  }

  function bufferText(term) {
    const lines = [];
    for (let row = 0; row < term.buffer.active.length; row += 1) {
      const line = term.buffer.active.getLine(row);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines.join('\n').replace(/\n+$/, '');
  }

  function exportCurrentTerminal(targetSession = null) {
    const session = targetSession || sessions.get(activeId);
    if (!session) return;
    const blob = new Blob([bufferText(session.term)], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `lumen-${session.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
    showToast('终端输出已导出');
  }

  async function pasteIntoSession(session) {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        showToast('剪贴板中没有可粘贴的文字');
        return;
      }
      session.term.paste(text);
      session.term.focus();
    } catch (error) {
      console.warn('[lumen] clipboard read was denied', error);
      showToast('浏览器不允许读取剪贴板，请使用 Ctrl+Shift+V', 4200);
    }
  }

  function searchSelection(session) {
    const text = normalizeSelectionFromTerminal(session.term).replace(/\s+/g, ' ').trim();
    if (!text) return;
    activateSession(session.id);
    terminalSearchInput.value = text.slice(0, 160);
    openTerminalSearch();
  }

  function tabContextItems(session) {
    return [
      {
        label: '切换到此标签',
        icon: 'activate',
        disabled: session.id === activeId,
        action: () => activateSession(session.id),
      },
      { label: '重命名', icon: 'rename', action: () => beginRename(session) },
      { label: '导出终端输出', icon: 'export', action: () => exportCurrentTerminal(session) },
      { separator: true },
      {
        label: '仅关闭标签',
        icon: 'close',
        disabled: sessions.size === 1,
        action: () => detachSession(session.id),
      },
      {
        label: '终止会话',
        icon: 'terminate',
        danger: true,
        action: () => openSessionDialog(session.id),
      },
    ];
  }

  function terminalContextItems(session) {
    if (session.term.hasSelection()) {
      return [
        {
          label: '复制',
          icon: 'copy',
          shortcut: navigator.platform.includes('Mac') ? '⌘C' : 'Ctrl+Shift+C',
          action: () => {
            const text = normalizeSelectionFromTerminal(session.term);
            if (text) void writeSystemClipboard(text, true, true);
          },
        },
        { label: '搜索选中文字', icon: 'search', action: () => searchSelection(session) },
        { label: '清除选区', icon: 'clear', action: () => session.term.clearSelection() },
        { separator: true },
        { label: '全选', icon: 'select', action: () => session.term.selectAll() },
        { label: '导出终端输出', icon: 'export', action: () => exportCurrentTerminal(session) },
      ];
    }
    return [
      {
        label: '粘贴',
        icon: 'paste',
        shortcut: navigator.platform.includes('Mac') ? '⌘V' : 'Ctrl+Shift+V',
        action: () => void pasteIntoSession(session),
      },
      { label: '全选', icon: 'select', action: () => session.term.selectAll() },
      { label: '搜索', icon: 'search', shortcut: settings.shortcuts.search, action: openTerminalSearch },
      { separator: true },
      { label: '导出终端输出', icon: 'export', action: () => exportCurrentTerminal(session) },
      {
        label: '清屏',
        icon: 'clear',
        action: () => {
          session.term.clear();
          session.term.focus();
        },
      },
    ];
  }

  function stripContextItems() {
    return [
      { label: '新建终端', icon: 'add', shortcut: settings.shortcuts.newTab, action: addSession },
      {
        label: '管理会话',
        icon: 'sessions',
        action: () => {
          renderSessionManager();
          sessionManagerDialog.showModal();
        },
      },
      { label: '终端设置', icon: 'settings', action: openSettings },
    ];
  }

  function findInTerminal(direction = 1) {
    const session = sessions.get(activeId);
    const query = terminalSearchInput.value;
    if (!session || !query) {
      terminalSearchStatus.textContent = '';
      return;
    }
    const term = session.term;
    const matches = [];
    const needle = query.toLocaleLowerCase();
    for (let row = 0; row < term.buffer.active.length; row += 1) {
      const line = term.buffer.active.getLine(row);
      if (!line) continue;
      const text = line.translateToString(false);
      let column = 0;
      const comparable = text.toLocaleLowerCase();
      while ((column = comparable.indexOf(needle, column)) >= 0) {
        matches.push({ row, column });
        column += Math.max(needle.length, 1);
      }
    }
    if (!matches.length) {
      terminalSearchStatus.textContent = '无结果';
      return;
    }
    const current = Number(terminalSearch.dataset.matchIndex || (direction > 0 ? -1 : 0));
    const next = (current + direction + matches.length) % matches.length;
    terminalSearch.dataset.matchIndex = String(next);
    const match = matches[next];
    term.select(match.column, match.row, query.length);
    term.scrollToLine(match.row);
    terminalSearchStatus.textContent = `${next + 1}/${matches.length}`;
  }

  function openTerminalSearch() {
    terminalSearch.hidden = false;
    terminalSearch.dataset.matchIndex = '-1';
    terminalSearchInput.focus();
    terminalSearchInput.select();
    findInTerminal(1);
  }

  function closeTerminalSearch() {
    terminalSearch.hidden = true;
    terminalSearchStatus.textContent = '';
    sessions.get(activeId)?.term.focus();
  }

  function renderSessionManager() {
    sessionManagerList.replaceChildren();
    for (const session of sessions.values()) {
      const row = document.createElement('div');
      row.className = 'session-manager-row';
      const copy = document.createElement('span');
      const state = session.state === 'online' ? '已连接' : session.state === 'connecting' ? '连接中' : '离线';
      copy.innerHTML = `<strong></strong><small></small>`;
      copy.querySelector('strong').textContent = session.name;
      copy.querySelector('small').textContent =
        `${session.id} · ${state}${session.lastLatency == null ? '' : ` · ${Math.round(session.lastLatency)} ms`}`;
      const activate = document.createElement('button');
      activate.type = 'button';
      activate.textContent = '切换';
      activate.addEventListener('click', () => {
        sessionManagerDialog.close();
        settingsDialog.close();
        activateSession(session.id);
      });
      const terminate = document.createElement('button');
      terminate.type = 'button';
      terminate.className = 'danger';
      terminate.textContent = '结束';
      terminate.addEventListener('click', () => {
        sessionManagerDialog.close();
        settingsDialog.close();
        openSessionDialog(session.id);
      });
      const actions = document.createElement('span');
      actions.className = 'session-manager-actions';
      actions.append(activate, terminate);
      row.append(copy, actions);
      sessionManagerList.append(row);
    }
  }

  function shortcutFromEvent(event) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return '';
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    parts.push(event.code.replace(/^Key/, '').replace(/^Digit/, ''));
    return parts.join('+');
  }

  function shortcutMatches(event, shortcut) {
    const pressed = shortcutFromEvent(event).toLowerCase();
    return pressed && pressed === shortcut.toLowerCase();
  }

  function captureShortcut(input, name) {
    input.addEventListener('keydown', event => {
      event.preventDefault();
      event.stopPropagation();
      const shortcut = shortcutFromEvent(event);
      if (!shortcut || !/[+]/.test(shortcut)) return;
      settings.shortcuts[name] = shortcut;
      input.value = shortcut;
      saveSettings();
    });
  }

  function syncSettingsControls() {
    copySelectionSetting.checked = settings.copySelection;
    setCustomSelect(closeBehaviorSetting, settings.closeBehavior);
    applyFontSize(settings.fontSize);
    setCustomSelect(cursorStyleSetting, settings.cursorStyle);
    cursorBlinkSetting.checked = settings.cursorBlink;
    lineHeightSetting.value = String(settings.lineHeight);
    lineHeightValue.value = settings.lineHeight.toFixed(2);
    workingDirectorySetting.value = settings.workingDirectory;
    protectRunningSetting.checked = settings.protectRunning;
    shortcutSearchSetting.value = settings.shortcuts.search;
    shortcutNewTabSetting.value = settings.shortcuts.newTab;
  }

  function openSettings() {
    hideContextMenu();
    syncSettingsControls();
    settingsDialog.showModal();
    requestAnimationFrame(() => copySelectionSetting.focus());
  }

  function setMobileCtrl(active) {
    mobileCtrl = active;
    mobileKeys.querySelector('[data-modifier="ctrl"]')?.classList.toggle('is-active', active);
  }

  addButton.addEventListener('click', addSession);
  tabStrip.addEventListener('contextmenu', event => {
    if (event.target.closest('.terminal-tab')) return;
    showContextMenu(event, stripContextItems(), () => sessions.get(activeId)?.term.focus());
  });
  settingsButton.addEventListener('click', openSettings);
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
  settingsDialog.addEventListener('click', event => {
    if (event.target === settingsDialog) settingsDialog.close();
  });
  settingsDialog.addEventListener('close', () => {
    for (const control of document.querySelectorAll('.custom-select.is-open')) closeCustomSelect(control);
    sessions.get(activeId)?.term.focus();
  });
  copySelectionSetting.addEventListener('change', () => {
    settings.copySelection = copySelectionSetting.checked;
    saveSettings();
  });
  closeBehaviorSetting.addEventListener('change', () => {
    settings.closeBehavior = closeBehaviorSetting.dataset.value;
    saveSettings();
  });
  fontSizeSetting.addEventListener('input', () => {
    applyFontSize(Number(fontSizeSetting.value));
    saveSettings();
  });
  cursorStyleSetting.addEventListener('change', () => {
    settings.cursorStyle = cursorStyleSetting.dataset.value;
    applyTerminalAppearance();
    saveSettings();
  });
  cursorBlinkSetting.addEventListener('change', () => {
    settings.cursorBlink = cursorBlinkSetting.checked;
    applyTerminalAppearance();
    saveSettings();
  });
  lineHeightSetting.addEventListener('input', () => {
    settings.lineHeight = Number(lineHeightSetting.value);
    applyTerminalAppearance();
    saveSettings();
  });
  workingDirectorySetting.addEventListener('change', () => {
    settings.workingDirectory = workingDirectorySetting.value.trim().slice(0, 240);
    saveSettings();
  });
  protectRunningSetting.addEventListener('change', () => {
    settings.protectRunning = protectRunningSetting.checked;
    saveSettings();
  });
  captureShortcut(shortcutSearchSetting, 'search');
  captureShortcut(shortcutNewTabSetting, 'newTab');
  installCustomSelect(closeBehaviorSetting);
  installCustomSelect(cursorStyleSetting);
  exportTerminalButton.addEventListener('click', exportCurrentTerminal);
  openSessionManagerButton.addEventListener('click', () => {
    renderSessionManager();
    settingsDialog.close();
    requestAnimationFrame(() => sessionManagerDialog.showModal());
  });
  document.getElementById('session-manager-close')
    .addEventListener('click', () => sessionManagerDialog.close());
  terminalSearchInput.addEventListener('input', () => {
    terminalSearch.dataset.matchIndex = '-1';
    findInTerminal(1);
  });
  terminalSearchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      findInTerminal(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      closeTerminalSearch();
    }
  });
  document.getElementById('terminal-search-previous')
    .addEventListener('click', () => findInTerminal(-1));
  document.getElementById('terminal-search-next')
    .addEventListener('click', () => findInTerminal(1));
  document.getElementById('terminal-search-close')
    .addEventListener('click', closeTerminalSearch);
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
    if (!contextMenu.hidden) {
      const buttons = [...contextMenu.querySelectorAll('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        hideContextMenu(true);
        return;
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const next = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
        return;
      }
    }
    if (shortcutMatches(event, settings.shortcuts.search)) {
      event.preventDefault();
      openTerminalSearch();
      return;
    }
    const newTabShortcut = shortcutMatches(event, settings.shortcuts.newTab)
      || (event.metaKey && !event.shiftKey && event.code === 'KeyT');
    if (newTabShortcut) {
      event.preventDefault();
      addSession();
    }
    if (event.metaKey && !event.shiftKey && event.code === 'KeyW') {
      event.preventDefault();
      if (activeId) requestCloseSession(activeId);
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

  document.addEventListener('pointerdown', event => {
    if (!contextMenu.hidden && !contextMenu.contains(event.target)) hideContextMenu();
  }, true);
  window.addEventListener('blur', () => hideContextMenu());
  window.addEventListener('resize', () => hideContextMenu());

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
