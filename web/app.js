(() => {
  'use strict';

  const STORAGE_KEY = 'lumen.tabs.v1';
  const THEME_KEY = 'lumen.theme.v1';
  const SETTINGS_KEY = 'lumen.settings.v1';
  const MAX_TABS = 16;
  const FLOW_LIMIT = 100000;
  const FLOW_HIGH_WATER = 10;
  const FLOW_LOW_WATER = 4;
  const HEALTH_REFRESH_INTERVAL = 3000;
  const MAX_CLIPBOARD_BYTES = 1024 * 1024;
  const MAX_CLIPBOARD_BASE64 = Math.ceil(MAX_CLIPBOARD_BYTES / 3) * 4;
  const {
    computeTerminalSelectionRanges,
    normalizeSelectionFromTerminal,
  } = globalThis.LumenSelection;
  const {
    formatDateTime,
    formatDuration,
    isCurrentConnection,
  } = globalThis.LumenSessionManager;
  const { AdaptivePoller, preferencePatch } = globalThis.LumenRuntime;
  const splitLayout = new globalThis.LumenSplitLayout();
  const { EVENT_LABELS: AUDIT_EVENT_LABELS, filter: filterAuditEntries,
    serialize: serializeAuditEntries } = globalThis.LumenAuditLog;
  const { isDangerous: isDangerousSnippet, normalize: normalizeSnippet,
    upsert: upsertSnippet } = globalThis.LumenCommandSnippets;
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
  const authChannel = 'BroadcastChannel' in window ? new BroadcastChannel('lumen-auth') : null;
  const tabList = document.getElementById('tab-list');
  const stage = document.getElementById('terminal-stage');
  const splitDivider = document.createElement('button');
  splitDivider.type = 'button';
  splitDivider.className = 'split-divider';
  splitDivider.hidden = true;
  splitDivider.setAttribute('aria-label', '拖动调整分屏比例');
  splitDivider.setAttribute('role', 'separator');
  splitDivider.setAttribute('aria-valuemin', '25');
  splitDivider.setAttribute('aria-valuemax', '75');
  splitDivider.setAttribute('aria-valuenow', '50');
  stage.append(splitDivider);
  const addButton = document.getElementById('add-tab');
  const themeButton = document.getElementById('theme-toggle');
  const focusButton = document.getElementById('focus-toggle');
  const settingsButton = document.getElementById('settings-toggle');
  const logoutToggleButton = document.getElementById('logout-toggle');
  const tabSessionPopover = document.getElementById('tab-session-popover');
  const settingsDialog = document.getElementById('settings-dialog');
  const copySelectionSetting = document.getElementById('setting-copy-selection');
  const fontSizeSetting = document.getElementById('setting-font-size');
  const fontSizeValue = document.getElementById('setting-font-size-value');
  const themeSetting = document.getElementById('setting-theme');
  const fontFamilySetting = document.getElementById('setting-font-family');
  const fontWeightSetting = document.getElementById('setting-font-weight');
  const fontWeightValue = document.getElementById('setting-font-weight-value');
  const letterSpacingSetting = document.getElementById('setting-letter-spacing');
  const letterSpacingValue = document.getElementById('setting-letter-spacing-value');
  const scrollbackSetting = document.getElementById('setting-scrollback');
  const scrollbackValue = document.getElementById('setting-scrollback-value');
  const cursorStyleSetting = document.getElementById('setting-cursor-style');
  const cursorBlinkSetting = document.getElementById('setting-cursor-blink');
  const lineHeightSetting = document.getElementById('setting-line-height');
  const lineHeightValue = document.getElementById('setting-line-height-value');
  const workingDirectorySetting = document.getElementById('setting-working-directory');
  const inheritWorkingDirectorySetting = document.getElementById('setting-inherit-working-directory');
  const persistTerminalStateSetting = document.getElementById('setting-persist-terminal-state');
  const rootMaxSessionsSetting = document.getElementById('setting-root-max-sessions');
  const defaultRootSessionSetting = document.getElementById('setting-default-root-session');
  const rootRequireVerificationSetting = document.getElementById('setting-root-require-verification');
  const shortcutSearchSetting = document.getElementById('setting-shortcut-search');
  const shortcutNewTabSetting = document.getElementById('setting-shortcut-new-tab');
  const exportTerminalButton = document.getElementById('export-terminal');
  const registerPasskeyButton = document.getElementById('register-passkey');
  const enableTotpButton = document.getElementById('enable-totp');
  const totpStatus = document.getElementById('totp-status');
  const totpSetupDialog = document.getElementById('totp-setup-dialog');
  const totpSetupTitle = document.getElementById('totp-setup-title');
  const totpSetupDescription = document.getElementById('totp-setup-description');
  const totpSecretPanel = document.getElementById('totp-secret-panel');
  const totpSecretUri = document.getElementById('totp-secret-uri');
  const totpQr = document.getElementById('totp-qr');
  const totpConfirmCode = document.getElementById('totp-confirm-code');
  const totpSetupCancel = document.getElementById('totp-setup-cancel');
  const totpSetupCopy = document.getElementById('totp-setup-copy');
  const totpSetupConfirm = document.getElementById('totp-setup-confirm');
  const passkeyList = document.getElementById('passkey-list');
  const passkeyActionDialog = document.getElementById('passkey-action-dialog');
  const passkeyActionTitle = document.getElementById('passkey-action-title');
  const passkeyActionDescription = document.getElementById('passkey-action-description');
  const passkeyNameField = document.getElementById('passkey-name-field');
  const passkeyNameInput = document.getElementById('passkey-name-input');
  const passkeyActionCancel = document.getElementById('passkey-action-cancel');
  const passkeyActionConfirm = document.getElementById('passkey-action-confirm');
  const settingsTabs = [...document.querySelectorAll('[data-settings-tab]')];
  const settingsPanels = [...document.querySelectorAll('[data-settings-panel]')];
  const logoutSessionButton = document.getElementById('logout-session');
  const logoutDialog = document.getElementById('logout-dialog');
  const logoutCancelButton = document.getElementById('logout-cancel');
  const terminalSearch = document.getElementById('terminal-search');
  const terminalSearchInput = document.getElementById('terminal-search-input');
  const terminalSearchStatus = document.getElementById('terminal-search-status');
  const sessionManagerList = document.getElementById('session-manager-list');
  const refreshSessionManagerButton = document.getElementById('refresh-session-manager');
  const cleanupIdleSessionsButton = document.getElementById('cleanup-idle-sessions');
  const idleCleanupDialog = document.getElementById('idle-cleanup-dialog');
  const idleCleanupList = document.getElementById('idle-cleanup-list');
  const idleCleanupCancel = document.getElementById('idle-cleanup-cancel');
  const idleCleanupConfirm = document.getElementById('idle-cleanup-confirm');
  const idleCleanupDescription = document.getElementById('idle-cleanup-description');
  const idleCleanupSummary = document.getElementById('idle-cleanup-summary');
  const idleCleanupThreshold = document.getElementById('idle-cleanup-threshold');
  const idleCleanupPreview = document.getElementById('idle-cleanup-preview');
  const diagnosticsList = document.getElementById('diagnostics-list');
  const diagnosticsSourceFilter = document.getElementById('diagnostics-source-filter');
  const diagnosticsCount = document.getElementById('diagnostics-count');
  const auditRetentionPolicy = document.getElementById('audit-retention-policy');
  const sessionManagerSearch = document.getElementById('session-manager-search');
  const sessionManagerSort = document.getElementById('session-manager-sort');
  const sessionStatusFilter = document.getElementById('session-status-filter');
  const sessionSelectionCount = document.getElementById('session-selection-count');
  const serviceHealthGrid = document.getElementById('service-health-grid');
  const serviceHealthSummary = document.getElementById('service-health-summary');
  const dependencyGrid = document.getElementById('dependency-grid');
  const dependencySummary = document.getElementById('dependency-summary');
  const refreshDependenciesButton = document.getElementById('refresh-dependencies');
  const commandSnippetList = document.getElementById('command-snippet-list');
  const commandSnippetEditor = document.getElementById('command-snippet-editor');
  const commandSnippetName = document.getElementById('command-snippet-name');
  const commandSnippetCommand = document.getElementById('command-snippet-command');
  const commandSnippetRun = document.getElementById('command-snippet-run');
  const auditLogList = document.getElementById('audit-log-list');
  const auditLogSearch = document.getElementById('audit-log-search');
  const auditLogCount = document.getElementById('audit-log-count');
  const refreshAuditLogButton = document.getElementById('refresh-audit-log');
  const auditEventFilter = document.getElementById('audit-event-filter');
  const auditTimeFilter = document.getElementById('audit-time-filter');
  const auditAutoRefresh = document.getElementById('audit-auto-refresh');
  const connectionDialog = document.getElementById('connection-dialog');
  const connectionDialogDescription = document.getElementById('connection-dialog-description');
  const connectionDisconnectCancel = document.getElementById('connection-disconnect-cancel');
  const connectionDisconnectConfirm = document.getElementById('connection-disconnect-confirm');
  const toast = document.getElementById('toast');
  const toastMessage = document.getElementById('toast-message');
  const toastAction = document.getElementById('toast-action');
  const mobileKeys = document.getElementById('mobile-keys');
  const sessionDialog = document.getElementById('session-dialog');
  const sessionDialogDescription = document.getElementById('session-dialog-description');
  const sessionDetach = document.getElementById('session-detach');
  const sessionTerminate = document.getElementById('session-terminate');
  const sessionCancel = document.getElementById('session-cancel');
  const tabStrip = document.getElementById('tab-strip');
  const contextMenu = document.getElementById('context-menu');
  const basePath = window.location.pathname.replace(/\/+$/, '');

  const decodeBase64Url = value => Uint8Array.from(
    atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(value.length + (4 - value.length % 4) % 4, '=')),
    character => character.charCodeAt(0),
  );
  const encodeBase64Url = value => btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const isReservedRootSessionId = value => /^root-[1-8]$/.test(String(value || ''));
  let activeId = null;
  let editingSnippetId = null;
  let tokenPromise = null;
  let toastTimer = null;
  let preferencesSaveTimer = null;
  let preferencesReady = false;
  let preferencesDirty = false;
  let lastSyncedPreferences = null;
  let preferencesVersion = '0';
  let pingSequence = 0;
  let mobileCtrl = false;
  let pendingCloseId = null;
  let pendingForceTerminate = false;
  let websocketReconnectCount = 0;
  let latestHealthReport = null;
  let sessionActionPending = false;
  let pendingConnection = null;
  let contextMenuRestoreFocus = null;
  let sessionInventory = [];
  let sessionInventoryUpdatedAt = 0;
  let auditEntries = [];
  let auditEventCategory = 'all';
  let auditTimeRange = 'all';
  let diagnosticsSource = 'all';
  let sessionSort = 'created-desc';
  let sessionStatus = 'all';
  const selectedSessionIds = new Set();
  let pendingCleanupCandidates = null;
  const sessionNoteSaveTimers = new Map();
  const defaultFontSize = window.matchMedia('(max-width: 560px)').matches ? 13 : 14;
  let settings = loadSettings();
  let tabPopoverTimer = null;
  let hoveredTabId = null;
  const popoverHideTimers = new WeakMap();
  let activeSettingsTab = 'general';
  let totpEnabled = false;
  let pendingPasskeyAction = null;
  let privilegedPolicy = { maxSessions: 2, idleSeconds: 1800, requireVerification: true };
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
      fontSize: defaultFontSize,
      fontFamily: 'system',
      fontWeight: 400,
      letterSpacing: 0.1,
      scrollback: 5000,
      cursorStyle: 'bar',
      cursorBlink: true,
      lineHeight: 1.22,
      workingDirectory: '/home/ubuntu',
      inheritWorkingDirectory: true,
      persistTerminalState: true,
      rootMaxSessions: 2,
      defaultRootSession: false,
      rootRequireVerification: true,
      idleCleanupSeconds: 1800,
      sessionNotes: {},
      commandSnippets: [],
      shortcuts: { search: 'Ctrl+Shift+F', newTab: 'Ctrl+Shift+T' },
    };
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      return {
        copySelection: typeof saved?.copySelection === 'boolean'
          ? saved.copySelection
          : defaults.copySelection,
        fontSize: Number.isInteger(saved?.fontSize) && saved.fontSize >= 11 && saved.fontSize <= 20
          ? saved.fontSize
          : defaults.fontSize,
        fontFamily: ['system', 'jetbrains', 'cascadia', 'fira', 'sourcecode',
          'ibmplex', 'ubuntu', 'maple', 'hack'].includes(saved?.fontFamily)
          ? saved.fontFamily : defaults.fontFamily,
        fontWeight: Number.isInteger(saved?.fontWeight) && saved.fontWeight >= 300 && saved.fontWeight <= 700
          ? saved.fontWeight : defaults.fontWeight,
        letterSpacing: Number(saved?.letterSpacing) >= -1 && Number(saved?.letterSpacing) <= 2
          ? Number(saved.letterSpacing) : defaults.letterSpacing,
        scrollback: Number.isInteger(saved?.scrollback)
          && saved.scrollback >= 1000 && saved.scrollback <= 50000
          ? saved.scrollback : defaults.scrollback,
        cursorStyle: ['bar', 'block', 'underline'].includes(saved?.cursorStyle)
          ? saved.cursorStyle : defaults.cursorStyle,
        cursorBlink: typeof saved?.cursorBlink === 'boolean' ? saved.cursorBlink : defaults.cursorBlink,
        lineHeight: Number(saved?.lineHeight) >= 1 && Number(saved?.lineHeight) <= 1.6
          ? Number(saved.lineHeight) : defaults.lineHeight,
        workingDirectory: typeof saved?.workingDirectory === 'string'
          ? saved.workingDirectory.slice(0, 240) : defaults.workingDirectory,
        inheritWorkingDirectory: typeof saved?.inheritWorkingDirectory === 'boolean'
          ? saved.inheritWorkingDirectory : defaults.inheritWorkingDirectory,
        persistTerminalState: typeof saved?.persistTerminalState === 'boolean'
          ? saved.persistTerminalState : defaults.persistTerminalState,
        rootMaxSessions: Number.isInteger(saved?.rootMaxSessions)
          && saved.rootMaxSessions >= 1 && saved.rootMaxSessions <= 8
          ? saved.rootMaxSessions : defaults.rootMaxSessions,
        defaultRootSession: typeof saved?.defaultRootSession === 'boolean'
          ? saved.defaultRootSession : defaults.defaultRootSession,
        rootRequireVerification: typeof saved?.rootRequireVerification === 'boolean'
          ? saved.rootRequireVerification : defaults.rootRequireVerification,
        idleCleanupSeconds: [1800, 3600, 21600, 86400].includes(Number(saved?.idleCleanupSeconds))
          ? Number(saved.idleCleanupSeconds) : defaults.idleCleanupSeconds,
        sessionNotes: saved?.sessionNotes && typeof saved.sessionNotes === 'object'
          ? Object.fromEntries(Object.entries(saved.sessionNotes)
            .filter(([key, value]) => /^[A-Za-z0-9_-]{1,64}$/.test(key) && typeof value === 'string')
            .map(([key, value]) => [key, value.slice(0, 160)]))
          : {},
        commandSnippets: Array.isArray(saved?.commandSnippets)
          ? saved.commandSnippets.map(normalizeSnippet).filter(Boolean).slice(0, 40) : [],
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
    preferencesDirty = true;
    if (preferencesReady) schedulePreferencesSave();
  }

  function preferencesPayload() {
    return {
      ...settings,
      theme: followsSystemTheme ? 'system' : currentTheme,
    };
  }

  function schedulePreferencesSave() {
    clearTimeout(preferencesSaveTimer);
    preferencesSaveTimer = setTimeout(async () => {
      try {
        const current = preferencesPayload();
        const patch = preferencePatch(current, lastSyncedPreferences);
        if (!Object.keys(patch).length) {
          preferencesDirty = false;
          return;
        }
        const response = await fetch(`${basePath}/api/preferences`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-Lumen-Action': 'preferences-update',
          },
          body: JSON.stringify({ baseVersion: preferencesVersion, patch }),
        });
        if (response.status === 409) {
          await syncPreferences();
          preferencesDirty = true;
          schedulePreferencesSave();
          return;
        }
        if (!response.ok) throw new Error(`preferences update ${response.status}`);
        const saved = await response.json();
        preferencesVersion = String(saved.version || preferencesVersion);
        lastSyncedPreferences = { ...(lastSyncedPreferences || {}), ...patch };
        preferencesDirty = Object.keys(
          preferencePatch(preferencesPayload(), lastSyncedPreferences),
        ).length > 0;
        if (preferencesDirty) schedulePreferencesSave();
      } catch (error) {
        console.warn('[lumen] could not save preferences', error);
        globalThis.LumenDiagnostics.report('偏好同步', error);
      }
    }, 300);
  }

  async function syncPreferences() {
    try {
      const response = await fetch(`${basePath}/api/preferences`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`preferences returned ${response.status}`);
      const remote = await response.json();
      preferencesVersion = String(remote?._version || '0');
      delete remote._version;
      const hasRemote = remote && typeof remote === 'object' && Object.keys(remote).length > 0;
      if (hasRemote) lastSyncedPreferences = structuredClone(remote);
      if (hasRemote && !preferencesDirty) {
        const hydratedRemote = { ...remote };
        let migratedRootPreferences = false;
        for (const key of ['rootMaxSessions', 'defaultRootSession', 'rootRequireVerification']) {
          if (Object.hasOwn(remote, key)) continue;
          hydratedRemote[key] = settings[key];
          migratedRootPreferences = true;
        }
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(hydratedRemote));
        settings = loadSettings();
        const remoteTheme = ['dark', 'light', 'system'].includes(hydratedRemote.theme)
          ? hydratedRemote.theme : 'system';
        followsSystemTheme = remoteTheme === 'system';
        if (followsSystemTheme) {
          localStorage.removeItem(THEME_KEY);
          applyTheme(systemThemeQuery.matches ? 'light' : 'dark', false);
        } else {
          localStorage.setItem(THEME_KEY, remoteTheme);
          applyTheme(remoteTheme, false);
        }
        syncSettingsControls();
        applyTerminalAppearance();
        if (migratedRootPreferences) preferencesDirty = true;
      }
      preferencesReady = true;
      if (!hasRemote || preferencesDirty) schedulePreferencesSave();
    } catch (error) {
      preferencesReady = true;
      console.warn('[lumen] could not load preferences', error);
      globalThis.LumenDiagnostics.report('偏好同步', error);
    }
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

  function installCustomSelect(control, onChange) {
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
      setCustomSelect(control, option.dataset.value);
      onChange?.(option.dataset.value);
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
    if (typeof toast.hidePopover === 'function' && toast.matches(':popover-open')) toast.hidePopover();
  }

  function showToast(message, timeout = 2600, action = null) {
    toastMessage.textContent = message;
    toastAction.hidden = !action;
    toast.classList.toggle('has-action', Boolean(action));
    toastAction.textContent = action?.label || '';
    toastAction.onclick = action?.handler || null;
    if (typeof toast.showPopover === 'function') {
      if (toast.matches(':popover-open')) toast.hidePopover();
      toast.showPopover();
    }
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    if (timeout > 0) toastTimer = setTimeout(hideToast, timeout);
  }

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

    globalThis.LumenContextMenu.show(contextMenu, event, items, item => {
        hideContextMenu();
        item.action?.();
    });
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

  function terminalFontFamily() {
    const fontFamilies = {
      system: '"SFMono-Regular", "SF Mono", "Noto Sans Mono CJK SC", Menlo, Consolas, monospace',
      jetbrains: '"JetBrains Mono", "Maple Mono NF CN", "Noto Sans Mono CJK SC", monospace',
      cascadia: '"Cascadia Code", "Cascadia Mono", "Noto Sans Mono CJK SC", monospace',
      fira: '"Fira Code", "Fira Mono", "Noto Sans Mono CJK SC", monospace',
      sourcecode: '"Source Code Pro", "Noto Sans Mono CJK SC", monospace',
      ibmplex: '"IBM Plex Mono", "Noto Sans Mono CJK SC", monospace',
      ubuntu: '"Ubuntu Mono", "Noto Sans Mono CJK SC", monospace',
      maple: '"Maple Mono NF CN", "Maple Mono", "Noto Sans Mono CJK SC", monospace',
      hack: 'Hack, "Noto Sans Mono CJK SC", monospace',
    };
    return fontFamilies[settings.fontFamily] || fontFamilies.system;
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
      fontFamily: terminalFontFamily(),
      fontSize: settings.fontSize,
      fontWeight: String(settings.fontWeight),
      fontWeightBold: String(Math.min(700, settings.fontWeight + 200)),
      letterSpacing: settings.letterSpacing,
      lineHeight: settings.lineHeight,
      macOptionClickForcesSelection: true,
      macOptionIsMeta: true,
      minimumContrastRatio: TERM_MINIMUM_CONTRAST[currentTheme],
      rightClickSelectsWord: true,
      scrollback: settings.scrollback,
      smoothScrollDuration: 0,
      theme: TERM_THEMES[currentTheme],
    };
  }

  function saveState() {
    const tabs = [...sessions.values()].map(session => ({
      id: session.id,
      name: session.name,
      pinned: session.pinned,
      privileged: session.privileged,
      privilegedMode: session.privilegedMode,
    }));
    const split = splitLayout.serialize();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs, activeId, split }));
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
              pinned: Boolean(tab.pinned),
              privileged: tab.privileged === true && isReservedRootSessionId(tab.id),
              privilegedMode: tab.privilegedMode === 'create' ? 'create' : 'connect',
            }))
        : [];
      if (validTabs.length) {
        const validIds = new Set(validTabs.map(tab => tab.id));
        const split = state?.split
          && validIds.has(state.split.primaryId)
          && validIds.has(state.split.secondaryId)
          && state.split.primaryId !== state.split.secondaryId
          ? {
            primaryId: state.split.primaryId,
            secondaryId: state.split.secondaryId,
            direction: state.split.direction === 'horizontal' ? 'horizontal' : 'vertical',
            ratio: Math.min(0.75, Math.max(0.25, Number(state.split.ratio) || 0.5)),
          }
          : null;
        return {
          tabs: validTabs,
          activeId: validTabs.some(tab => tab.id === state.activeId) ? state.activeId : validTabs[0].id,
          split,
        };
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    return settings.defaultRootSession
      ? {
        tabs: [{ id: 'root-1', name: 'root 1', privileged: true, privilegedMode: 'create' }],
        activeId: 'root-1',
        split: null,
      }
      : { tabs: [{ id: 'main', name: 'main' }], activeId: 'main', split: null };
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

  function websocketUrl(id, connectionKey, skipReplay = false, readOnly = false, privilegedGrant = '') {
    return globalThis.LumenTerminalConnection.websocketUrl(
      window.location, basePath, id, connectionKey, skipReplay, readOnly, privilegedGrant,
    );
  }

  function isTerminalHandshakeResponse(data) {
    return typeof data === 'string'
      && /^(?:\x1b\[[>?=]?[0-9;]+c)+$/.test(data);
  }

  async function loadPrivilegedMethods(session) {
    if (session.privilegedMethods) return session.privilegedMethods;
    const response = await fetch(`${basePath}/api/privileged/methods`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`methods ${response.status}`);
    const methods = await response.json();
    privilegedPolicy = {
      maxSessions: Math.max(1, Math.min(8, Number(methods.maxSessions) || 2)),
      idleSeconds: Math.max(300, Math.min(86400, Number(methods.idleSeconds) || 1800)),
      requireVerification: methods.requireVerification !== false,
    };
    session.privilegedMethods = methods;
    return methods;
  }

  async function showPrivilegedGate(session) {
    if (!session?.privileged || session.destroyed) return;
    session.privilegedGate.hidden = true;
    session.mount.classList.add('is-privileged-locked');
    session.privilegedGateError.hidden = true;
    session.privilegedGateDescription.textContent =
      `${session.privilegedMode === 'create' ? '创建' : '连接'} ${session.id} 前需要重新验证。`;
    try {
      const methods = await loadPrivilegedMethods(session);
      session.privilegedTotpField.hidden = !methods.totp;
      session.privilegedTotpButton.hidden = !methods.totp;
      session.privilegedPasskeyButton.hidden = !methods.passkey;
      session.privilegedGatePolicy.textContent =
        `最多 ${privilegedPolicy.maxSessions} 个 root 会话 · 空闲约 ${Math.round(privilegedPolicy.idleSeconds / 60)} 分钟后自动结束`;
      if (!privilegedPolicy.requireVerification) {
        session.privilegedGateDescription.textContent = `正在安全连接 ${session.id}…`;
        session.privilegedTotpField.hidden = true;
        session.privilegedTotpButton.hidden = true;
        session.privilegedPasskeyButton.hidden = true;
        await authorizePrivilegedGate(session, 'policy');
        return;
      }
      session.privilegedGate.hidden = false;
      if (!methods.totp && !methods.passkey) {
        session.privilegedGateError.textContent = '请先在安全设置中启用 TOTP 或添加通行密钥。';
        session.privilegedGateError.hidden = false;
      } else if (session.id === activeId && methods.totp) {
        requestAnimationFrame(() => session.privilegedTotpCode.focus());
      }
    } catch (error) {
      session.privilegedGate.hidden = false;
      session.privilegedGateError.textContent = '无法读取特权验证方式，请稍后重试。';
      session.privilegedGateError.hidden = false;
      globalThis.LumenDiagnostics.report('特权验证', error);
    }
  }

  async function authorizePrivilegedGate(session, method) {
    if (!session || session.authorizationPending
        || method !== 'policy' && session.id !== activeId) return;
    session.authorizationPending = true;
    session.privilegedGateError.hidden = true;
    session.privilegedTotpButton.disabled = true;
    session.privilegedPasskeyButton.disabled = true;
    try {
      let body;
      let endpoint;
      let headers = {
        'X-Lumen-Action': 'privileged-authorize',
        'X-Lumen-Session': session.id,
        'X-Lumen-Mode': session.privilegedMode,
      };
      if (method === 'passkey') {
        const optionsResponse = await fetch(`${basePath}/api/privileged/passkey/options`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!optionsResponse.ok) throw new Error(`options ${optionsResponse.status}`);
        const options = await optionsResponse.json();
        options.challenge = decodeBase64Url(options.challenge);
        options.allowCredentials = options.allowCredentials.map(item => ({
          ...item,
          id: decodeBase64Url(item.id),
        }));
        const credential = await navigator.credentials.get({ publicKey: options });
        body = JSON.stringify({
          id: encodeBase64Url(credential.rawId),
          clientDataJSON: encodeBase64Url(credential.response.clientDataJSON),
          authenticatorData: encodeBase64Url(credential.response.authenticatorData),
          signature: encodeBase64Url(credential.response.signature),
        });
        headers = { ...headers, 'Content-Type': 'application/json' };
        endpoint = 'passkey/verify';
      } else if (method === 'totp') {
        const code = session.privilegedTotpCode.value.replace(/\D/g, '');
        if (code.length !== 6) {
          session.privilegedGateError.textContent = '请输入六位动态验证码。';
          session.privilegedGateError.hidden = false;
          session.privilegedTotpCode.focus();
          return;
        }
        body = new URLSearchParams({ code }).toString();
        headers = { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' };
        endpoint = 'authorize/totp';
      } else {
        endpoint = 'authorize';
      }
      const response = await fetch(`${basePath}/api/privileged/${endpoint}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body,
      });
      if (!response.ok) throw new Error(`authorize ${response.status}`);
      const result = await response.json();
      if (!/^[0-9a-f]{64}$/.test(result.grant || '')) throw new Error('invalid grant');
      session.privilegedGrant = result.grant;
      session.privilegedMode = 'connect';
      session.privilegedTotpCode.value = '';
      session.privilegedGate.hidden = true;
      session.mount.classList.remove('is-privileged-locked');
      void connect(session);
    } catch (error) {
      const backgroundPolicyAuthorization = method === 'policy' && session.id !== activeId;
      if (method === 'policy') session.privilegedGate.hidden = backgroundPolicyAuthorization;
      session.privilegedGateError.textContent = error?.name === 'NotAllowedError'
        ? '通行密钥验证已取消。'
        : method === 'policy'
          ? '无法授权 root 会话，请稍后重试。'
          : '验证失败，请检查验证码或通行密钥后重试。';
      session.privilegedGateError.hidden = false;
      if (backgroundPolicyAuthorization && !session.destroyed) {
        session.reconnectAttempts += 1;
        scheduleReconnect(session);
      }
    } finally {
      session.authorizationPending = false;
      session.privilegedTotpButton.disabled = false;
      session.privilegedPasskeyButton.disabled = false;
    }
  }

  function scheduleTerminalSnapshot(session) {
    if (session.privileged || !settings.persistTerminalState || !session.serializeAddon ||
        session.destroyed || session.restoring) return;
    clearTimeout(session.snapshotTimer);
    session.snapshotTimer = setTimeout(() => {
      const persist = async () => {
      try {
        const data = session.serializeAddon.serialize({ scrollback: settings.scrollback });
        if (new Blob([data]).size > 2 * 1024 * 1024) return;
        await globalThis.LumenTerminalState.save(session.id, {
          data,
          columns: session.term.cols,
          rows: session.term.rows,
          savedAt: Date.now(),
        });
        session.hasTerminalState = true;
      } catch (error) {
        console.warn('[lumen] could not persist terminal state', error);
        globalThis.LumenDiagnostics.report('IndexedDB', error);
      }
      };
      if ('requestIdleCallback' in window) requestIdleCallback(() => void persist(), { timeout: 1500 });
      else void persist();
    }, 900);
  }

  async function restoreTerminalSnapshot(session) {
    if (session.privileged || !settings.persistTerminalState) return false;
    try {
      const snapshot = await globalThis.LumenTerminalState.load(session.id);
      if (!snapshot?.data || typeof snapshot.data !== 'string') return false;
      session.restoring = true;
      if (snapshot.columns > 0 && snapshot.rows > 0) {
        session.term.resize(snapshot.columns, snapshot.rows);
      }
      await new Promise(resolve => session.term.write(snapshot.data, resolve));
      session.hasTerminalState = true;
      return true;
    } catch (error) {
      console.warn('[lumen] could not restore terminal state', error);
      globalThis.LumenDiagnostics.report('IndexedDB', error);
      return false;
    } finally {
      session.restoring = false;
    }
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
      session.latency.setAttribute('aria-label', state === 'connecting' ? '正在连接' : '连接已断开');
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
    session.latency.setAttribute('aria-label',
      `当前 ${Math.round(milliseconds)} 毫秒，平滑 ${Math.round(session.smoothedLatency)} 毫秒`);
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
    if (session.readOnly) return;
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
      scheduleTerminalSnapshot(session);
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
    scheduleTerminalSnapshot(session);
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
        session.tab.dataset.sessionTitle = title || session.name;
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

    if (session.privileged && !session.privilegedGrant) {
      setConnectionState(session, 'offline');
      if (session.id !== activeId) {
        try {
          const methods = await loadPrivilegedMethods(session);
          if (methods.requireVerification !== false) return;
        } catch (error) {
          session.reconnectAttempts += 1;
          scheduleReconnect(session);
          globalThis.LumenDiagnostics.report('特权验证', error);
          return;
        }
      }
      await showPrivilegedGate(session);
      return;
    }
    setConnectionState(session, 'connecting');

    let token = '';
    try {
      token = await getToken();
    } catch (error) {
      setConnectionState(session, 'offline');
      session.reconnectAttempts += 1;
      websocketReconnectCount += 1;
      if (session.reconnectAttempts === 2) showToast('无法验证访问身份，请检查安全入口');
      scheduleReconnect(session);
      return;
    }

    if (session.destroyed) return;
    const socket = new WebSocket(
      websocketUrl(session.id, session.connectionKey, session.hasTerminalState, session.readOnly,
        session.privilegedGrant),
      ['tty'],
    );
    session.socket = socket;
    session.privilegedGrant = null;
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', () => {
      if (session.destroyed || socket !== session.socket) return;
      const recovered = session.hasConnected && session.reconnectAttempts > 0;
      session.reconnectAttempts = 0;
      session.hasConnected = true;
      if (session.privileged) {
        session.privilegedMode = 'connect';
        session.privilegedGate.hidden = true;
        session.mount.classList.remove('is-privileged-locked');
      }
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
            sendInput(session,
              `source /opt/lumen-terminal/scripts/lumen-shell-integration.sh 2>/dev/null; cd -- '${quoted}'\r`);
          }
        }, 120);
      }
      scheduleResize(session);
      if (session.id === activeId) session.term.focus();
      if (recovered) showToast(`“${session.name}”已恢复连接，后台任务仍在运行`);
    });

    socket.addEventListener('message', event => {
      if (socket === session.socket && event.data instanceof ArrayBuffer) {
        handleSocketMessage(session, event);
      }
    });

    socket.addEventListener('close', event => {
      if (session.destroyed || socket !== session.socket) return;
      setConnectionState(session, 'offline');
      if (session.privileged) {
        clearTimeout(session.reconnectTimer);
        if (session.privilegedMethods?.requireVerification === false) {
          session.reconnectAttempts += 1;
          scheduleReconnect(session);
          return;
        }
        if (session.id === activeId) {
          void showPrivilegedGate(session);
          showToast(`“${session.name}”需要重新验证后才能连接`);
        }
        return;
      }
      if (event.code === 4001) {
        clearTimeout(session.reconnectTimer);
        showToast(`“${session.name}”的连接已被管理员断开，刷新页面可重新连接`);
        return;
      }
      if (event.code !== 1000) {
        globalThis.LumenDiagnostics.report('WebSocket', `连接关闭：${event.code} ${event.reason || ''}`.trim());
      }
      session.reconnectAttempts += 1;
      websocketReconnectCount += 1;
      scheduleReconnect(session);
    });

    socket.addEventListener('error', () => {
      globalThis.LumenDiagnostics.report('WebSocket', `会话 ${session.id} 连接异常`);
      if (socket === session.socket) socket.close();
    });
  }

  function scheduleReconnect(session) {
    if (session.destroyed) return;
    const delay = Math.min(8000,
      globalThis.LumenTerminalConnection.reconnectDelay(session.reconnectAttempts));
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

    const rootBadge = document.createElement('span');
    rootBadge.className = 'root-badge';
    rootBadge.textContent = 'ROOT';
    rootBadge.hidden = !session.privileged;

    const legacyBadge = document.createElement('span');
    legacyBadge.className = 'legacy-backend-badge';
    legacyBadge.textContent = '旧';
    legacyBadge.title = '此会话仍由旧版 tmux 承载，将在自然结束后退出迁移';
    legacyBadge.hidden = true;

    const latency = document.createElement('span');
    latency.className = 'latency';
    latency.textContent = '···';

    const connections = document.createElement('span');
    connections.className = 'tab-connections';
    connections.hidden = true;
    connections.title = '当前连接数';

    const protection = document.createElement('span');
    protection.className = 'tab-protection';
    protection.hidden = true;
    protection.title = '此会话受保护，不参与空闲清理';
    protection.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.6 2.9 8 7 10 4.1-2 7-5.4 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-5"/></svg>';

    const close = document.createElement('button');
    close.className = 'close-tab';
    close.type = 'button';
    close.title = '关闭或结束终端';
    close.setAttribute('aria-label', `关闭或结束 ${session.name}`);
    close.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9"/></svg>';

    tab.classList.toggle('is-privileged', session.privileged);
    tab.append(dot, name, rootBadge, legacyBadge, latency, connections, protection, close);
    tab.addEventListener('click', event => {
      if (!event.target.closest('.close-tab, .tab-name-input')) activateSession(session.id);
    });
    tab.addEventListener('dblclick', event => {
      if (event.target.closest('.close-tab, .tab-name-input')) return;
      event.preventDefault();
      requestCloseSession(session.id);
    });
    latency.addEventListener('pointerenter', () => {
      hoveredTabId = session.id;
      clearTimeout(tabPopoverTimer);
      tabPopoverTimer = setTimeout(() => {
        if (hoveredTabId !== session.id) return;
        renderTabSessionPopover(session);
        if (Date.now() - sessionInventoryUpdatedAt < 3000) return;
        void refreshSessionInventory().then(() => {
          if (hoveredTabId === session.id) renderTabSessionPopover(session);
        });
      }, 320);
    });
    latency.addEventListener('pointerleave', () => {
      if (hoveredTabId === session.id) hoveredTabId = null;
      clearTimeout(tabPopoverTimer);
      hideHoverPopover(tabSessionPopover);
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
      if (session.pinned) setSessionPinned(session, false);
      else requestCloseSession(session.id);
    });

    session.tab = tab;
    session.nameNode = name;
    session.latency = latency;
    session.connections = connections;
    return tab;
  }

  function positionHoverPopover(popover, anchor) {
    clearTimeout(popoverHideTimers.get(popover));
    popover.classList.remove('is-closing');
    popover.hidden = false;
    const anchorRect = anchor.getBoundingClientRect();
    // These layout dimensions stay stable while the entrance animation scales
    // the bubble; getBoundingClientRect would make a refresh shift it.
    const popoverWidth = popover.offsetWidth;
    const popoverHeight = popover.offsetHeight;
    const left = Math.min(window.innerWidth - popoverWidth - 12,
      Math.max(12, anchorRect.left + anchorRect.width / 2 - popoverWidth / 2));
    const top = Math.min(window.innerHeight - popoverHeight - 12, anchorRect.bottom + 8);
    popover.style.left = `${left}px`;
    popover.style.top = `${Math.max(12, top)}px`;
    const arrowX = Math.min(popoverWidth - 20,
      Math.max(20, anchorRect.left + anchorRect.width / 2 - left));
    popover.style.setProperty('--popover-arrow-x', `${arrowX}px`);
  }

  function cancelHideHoverPopover(popover) {
    clearTimeout(popoverHideTimers.get(popover));
    popoverHideTimers.delete(popover);
    popover.classList.remove('is-closing');
  }

  function hideHoverPopover(popover, immediate = false) {
    clearTimeout(popoverHideTimers.get(popover));
    if (immediate || popover.hidden) {
      popover.classList.remove('is-closing');
      popover.hidden = true;
      return;
    }
    const delayTimer = setTimeout(() => {
      popover.classList.add('is-closing');
      const finishTimer = setTimeout(() => {
        popover.hidden = true;
        popover.classList.remove('is-closing');
        popoverHideTimers.delete(popover);
      }, 110);
      popoverHideTimers.set(popover, finishTimer);
    }, 90);
    popoverHideTimers.set(popover, delayTimer);
  }

  function renderTabSessionPopover(session) {
    if (!session?.tab?.isConnected) return;
    const item = sessionInventory.find(candidate => candidate.id === session.id);
    const createdAt = Number(item?.createdAt || 0) * 1000;
    const memory = Number(item?.memoryKb || 0);
    const details = [
      ['身份', session.privileged ? 'root · 特权会话' : 'ubuntu · 普通会话'],
      ['会话后端', item?.backend === 'worker' ? '原生 PTY worker' : '旧版 tmux（迁移中）'],
      ['状态', session.state === 'online' ? '已连接' : session.state === 'connecting' ? '连接中' : '离线'],
      ['连接', `${Number(item?.clients || 0)} 个客户端`],
      ['运行时间', createdAt ? formatDuration(Date.now() - createdAt) : '等待后台数据'],
      ['CPU', item ? `${Number(item.cpuPercent || 0).toFixed(1)}%` : '—'],
      ['内存', memory ? `${(memory / 1024).toFixed(memory >= 10240 ? 0 : 1)} MiB` : '—'],
      ['前台进程', item?.foregroundCommand || '—'],
      ['工作目录', item?.workingDirectory || session.currentWorkingDirectory || '—'],
      ['保护策略', session.privileged ? '不适用 · 强制空闲回收' : item?.protected ? '已保护' : '未保护'],
    ];
    tabSessionPopover.dataset.state = session.state;
    tabSessionPopover.innerHTML = '<header><span><i class="session-popover-dot"></i><strong></strong></span><small></small></header><div class="tab-session-details"></div>';
    tabSessionPopover.querySelector('strong').textContent = session.name;
    tabSessionPopover.querySelector('header small').textContent = session.id;
    const list = tabSessionPopover.querySelector('.tab-session-details');
    for (const [label, value] of details) {
      const row = document.createElement('div');
      const term = document.createElement('span');
      const description = document.createElement('strong');
      term.textContent = label;
      description.textContent = value;
      row.append(term, description);
      list.append(row);
    }
    positionHoverPopover(tabSessionPopover, session.latency);
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
      updateTabPinControl(session);
      session.tab.setAttribute(
        'aria-label',
        `${session.name}，${session.state === 'online' ? '已连接' : session.state === 'connecting' ? '正在连接' : '离线'}`,
      );
      if (session.id === activeId) document.title = `${session.name} — Lumen`;
      saveState();
      if (session.privilegedGate && !session.privilegedGate.hidden) {
        session.privilegedTotpCode.focus();
      } else {
        session.term.focus();
      }
    };

    input.addEventListener('blur', () => finish(true), { once: true });
    input.addEventListener('pointerdown', event => event.stopPropagation());
    input.addEventListener('click', event => event.stopPropagation());
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
      initialWorkingDirectory: activate
        ? (meta.workingDirectory || settings.workingDirectory).trim()
        : '',
      currentWorkingDirectory: meta.workingDirectory || '',
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
      hasConnected: false,
      pinned: Boolean(meta.pinned),
      privileged: meta.privileged === true && isReservedRootSessionId(meta.id),
      privilegedGrant: meta.privilegedGrant || null,
      privilegedMode: meta.privilegedMode === 'create' ? 'create' : 'connect',
      privilegedMethods: null,
      authorizationPending: false,
      protected: false,
      readOnly: false,
      hasTerminalState: false,
      restoring: false,
      serializeAddon: null,
      snapshotTimer: null,
      connectionKey: crypto.randomUUID?.()
        || `${crypto.getRandomValues(new Uint32Array(4)).join('-')}`.padEnd(36, '0').slice(0, 36),
    };

    session.tab = makeTab(session);
    updateTabPinControl(session);
    tabList.append(session.tab);

    const pane = document.createElement('section');
    pane.className = 'terminal-pane';
    pane.id = `pane-${session.id}`;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', session.tab.id);
    pane.setAttribute('aria-hidden', 'true');
    const mount = document.createElement('div');
    mount.className = 'terminal-mount';
    session.mount = mount;
    const modeNotice = document.createElement('div');
    modeNotice.className = 'terminal-pane-mode';
    modeNotice.setAttribute('role', 'status');
    modeNotice.hidden = true;
    modeNotice.textContent = '只读模式 · 键盘输入不会发送到会话';
    pane.append(mount);
    pane.append(modeNotice);
    if (session.privileged) {
      const gate = document.createElement('div');
      gate.className = 'privileged-gate';
      gate.hidden = true;
      gate.innerHTML = `
        <div class="privileged-gate-card">
          <div class="privileged-gate-heading">
            <span class="privileged-gate-mark" aria-hidden="true">!</span>
            <div><span>Privileged session</span><h2>验证后进入 root 会话</h2></div>
          </div>
          <p class="privileged-gate-description"></p>
          <div class="privileged-gate-warning">root 会话拥有完整系统权限，创建、连接和结束操作都会写入安全审计日志。</div>
          <label class="privileged-gate-totp"><span>动态验证码</span><input type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></label>
          <p class="privileged-gate-error" role="alert" hidden></p>
          <small class="privileged-gate-policy"></small>
          <div class="privileged-gate-actions">
            <button class="privileged-gate-back" type="button">返回普通终端</button>
            <button class="privileged-gate-passkey" type="button">使用通行密钥</button>
            <button class="privileged-gate-submit" type="button">验证并连接</button>
          </div>
        </div>`;
      pane.append(gate);
      session.privilegedGate = gate;
      session.privilegedGateDescription = gate.querySelector('.privileged-gate-description');
      session.privilegedGateError = gate.querySelector('.privileged-gate-error');
      session.privilegedGatePolicy = gate.querySelector('.privileged-gate-policy');
      session.privilegedTotpField = gate.querySelector('.privileged-gate-totp');
      session.privilegedTotpCode = gate.querySelector('.privileged-gate-totp input');
      session.privilegedTotpButton = gate.querySelector('.privileged-gate-submit');
      session.privilegedPasskeyButton = gate.querySelector('.privileged-gate-passkey');
      session.privilegedTotpButton.addEventListener('click', () => void authorizePrivilegedGate(session, 'totp'));
      session.privilegedPasskeyButton.addEventListener('click', () => void authorizePrivilegedGate(session, 'passkey'));
      session.privilegedTotpCode.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void authorizePrivilegedGate(session, 'totp');
        }
      });
      gate.querySelector('.privileged-gate-back').addEventListener('click', () => {
        const ordinary = [...sessions.values()].find(candidate => !candidate.privileged && !candidate.destroyed);
        if (ordinary) activateSession(ordinary.id);
        else addSession();
      });
    }
    stage.append(pane);
    session.pane = pane;
    session.modeNotice = modeNotice;
    pane.addEventListener('pointerdown', () => {
      if (splitLayout.active && session.id !== activeId && splitLayout.contains(session.id)) {
        activateSession(session.id);
      }
    }, true);

    const term = new Terminal(terminalOptions());
    const fitAddon = new FitAddon.FitAddon();
    const serializeAddon = new SerializeAddon.SerializeAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(serializeAddon);
    term.loadAddon(new WebLinksAddon.WebLinksAddon((event, uri) => {
      if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
    }));
    term.parser.registerOscHandler(7, value => {
      try {
        const url = new URL(value);
        if (url.protocol !== 'file:') return false;
        const directory = decodeURIComponent(url.pathname);
        if (directory.startsWith('/') && directory.length <= 240) {
          session.currentWorkingDirectory = directory;
          session.tab.dataset.cwd = directory;
          session.tab.dataset.sessionTitle = `${session.name} · ${directory}`;
        }
      } catch {
        // Ignore malformed working-directory reports from terminal programs.
      }
      return true;
    });
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
    mount.addEventListener('paste', event => {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      event.preventDefault();
      event.stopPropagation();
      if (text) {
        term.paste(text);
        term.focus();
      } else {
        showToast('剪贴板中没有可粘贴的文字');
      }
    }, true);
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
    session.serializeAddon = serializeAddon;
    sessions.set(session.id, session);
    installSelectionOverlay(session);

    term.onData(data => {
      if (!session.restoring && !isTerminalHandshakeResponse(data)) sendInput(session, data);
    });
    term.onBinary(data => {
      if (!session.restoring) {
        sendInput(session, Uint8Array.from(data, character => character.charCodeAt(0)));
      }
    });
    term.onResize(() => {
      if (session.id === activeId || splitLayout.contains(session.id)) {
        scheduleResize(session);
      }
      scheduleSelectionOverlay(session);
    });
    term.attachCustomKeyEventHandler(event => {
      const copy = (event.ctrlKey && event.shiftKey && event.code === 'KeyC')
        || (event.metaKey && event.code === 'KeyC');
      const paste = (event.ctrlKey && event.code === 'KeyV')
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

    requestAnimationFrame(async () => {
      if (activate) activateSession(session.id);
      await restoreTerminalSnapshot(session);
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
    const isSplitMember = splitLayout.contains(id);
    activeId = id;

    for (const candidate of sessions.values()) {
      const active = candidate.id === id;
      const secondary = candidate.id === splitLayout.secondaryId;
      const visible = isSplitMember
        ? candidate.id === splitLayout.primaryId || secondary
        : active;
      candidate.tab.setAttribute('aria-selected', active ? 'true' : 'false');
      candidate.tab.setAttribute('tabindex', active ? '0' : '-1');
      candidate.pane.classList.toggle('is-active', visible);
      candidate.pane.classList.toggle('is-secondary', secondary);
      candidate.pane.classList.toggle('is-focused', active);
      candidate.pane.setAttribute('aria-hidden', visible ? 'false' : 'true');
    }
    stage.classList.toggle('is-split', Boolean(isSplitMember));
    stage.classList.toggle(
      'is-split-horizontal',
      Boolean(isSplitMember && splitLayout.direction === 'horizontal'),
    );
    stage.style.setProperty('--split-ratio', `${splitLayout.ratio * 100}%`);
    splitDivider.setAttribute('aria-orientation',
      splitLayout.direction === 'horizontal' ? 'horizontal' : 'vertical');
    splitDivider.setAttribute('aria-valuenow', String(Math.round(splitLayout.ratio * 100)));
    splitDivider.hidden = !isSplitMember;

    document.title = `${session.name} — Lumen`;
    session.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    requestAnimationFrame(() => {
      scheduleResize(session);
      if (isSplitMember) {
        scheduleResize(sessions.get(splitLayout.primaryId));
        scheduleResize(sessions.get(splitLayout.secondaryId));
      }
      if (session.privilegedGate && !session.privilegedGate.hidden) {
        session.privilegedTotpCode.focus();
      } else {
        session.term.focus();
      }
    });
    saveState();
    if (session.privileged && session.state === 'offline' && !session.authorizationPending) {
      void connect(session);
    }
  }

  function toggleSplitSession(session, direction = splitLayout.direction) {
    if (session.id === activeId) {
      if (splitLayout.active) {
        closeSplit();
      } else {
        showToast('请选择另一个标签加入分屏');
      }
      return;
    }
    const closesExisting =
      splitLayout.secondaryId === session.id && splitLayout.direction === direction;
    const primaryId = !splitLayout.active || !splitLayout.contains(session.id)
      ? activeId
      : splitLayout.primaryId;
    if (closesExisting) splitLayout.close();
    else splitLayout.open(primaryId, session.id, direction);
    activateSession(activeId);
    showToast(splitLayout.active
      ? `已在${splitLayout.direction === 'horizontal' ? '下方' : '右侧'}打开“${session.name}”`
      : '分屏已关闭');
  }

  function closeSplit(notify = true, restoreFocus = true) {
    if (!splitLayout.active) return;
    const focused = sessions.get(activeId);
    splitLayout.close();
    stage.classList.remove('is-split', 'is-split-horizontal', 'is-resizing-split');
    splitDivider.hidden = true;
    for (const candidate of sessions.values()) {
      const active = candidate.id === activeId;
      candidate.pane.classList.toggle('is-active', active);
      candidate.pane.classList.remove('is-secondary');
      candidate.pane.classList.toggle('is-focused', active);
      candidate.pane.setAttribute('aria-hidden', active ? 'false' : 'true');
    }
    if (focused) {
      scheduleResize(focused);
      if (restoreFocus) focused.term.focus();
    }
    if (notify) showToast('分屏已关闭');
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
    if (splitLayout.contains(id)) closeSplit(false, false);

    session.destroyed = true;
    clearTimeout(session.reconnectTimer);
    clearTimeout(session.resizeTimer);
    clearTimeout(session.snapshotTimer);
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

  function openSessionDialog(id, displayName = '') {
    const session = sessions.get(id);
    const inventory = sessionInventory.find(item => item.id === id);
    const protectedSession = Boolean(inventory?.protected || session?.protected);
    if ((!session && !displayName) || sessionActionPending) return;
    pendingCloseId = id;
    pendingForceTerminate = protectedSession;
    sessionDialogDescription.textContent = protectedSession
      ? `${session?.name || displayName} 是受保护会话。仍然结束会终止其中所有程序，且无法恢复。`
      : `${session?.name || displayName} 的后台任务需要如何处理？`;
    sessionTerminate.querySelector('span').textContent =
      protectedSession ? '仍要结束受保护会话' : '结束终端会话';
    sessionDialog.classList.toggle('is-protected-warning', protectedSession);
    sessionDetach.hidden = !session;
    sessionDetach.disabled = Boolean(session && sessions.size === 1);
    sessionDetach.title = session && sessions.size === 1 ? '界面至少保留一个标签' : '';
    sessionDialog.showModal();
    requestAnimationFrame(() => (!session || sessions.size === 1 ? sessionTerminate : sessionDetach).focus());
  }

  function requestCloseSession(id) {
    if (sessions.get(id)?.pinned) {
      showToast('请先取消固定此标签');
      return;
    }
    openSessionDialog(id);
  }

  function setSessionPinned(session, pinned) {
    session.pinned = Boolean(pinned);
    updateTabPinControl(session);
    saveState();
    showToast(session.pinned ? '标签已固定' : '已取消固定');
  }

  async function setSessionProtected(id, protectedSession, quiet = false) {
    const inventoryItem = sessionInventory.find(item => item.id === id);
    if (sessions.get(id)?.privileged || inventoryItem?.privileged === true) {
      if (!quiet) showToast('root 会话不支持保护，并始终受空闲回收策略约束');
      return;
    }
    try {
      const response = await fetch(`${basePath}/api/sessions/${encodeURIComponent(id)}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-Lumen-Action': protectedSession ? 'protect' : 'unprotect' },
      });
      if (response.status === 404) {
        await refreshSessionInventory();
        if (!quiet) showToast('该会话已经结束，列表已刷新');
        return;
      }
      if (!response.ok) throw new Error(`protection endpoint returned ${response.status}`);
      const session = sessions.get(id);
      if (session) {
        session.protected = protectedSession;
        session.tab.classList.toggle('is-protected', protectedSession);
        session.tab.querySelector('.tab-protection').hidden = !protectedSession;
      }
      await refreshSessionInventory();
      if (!quiet) showToast(protectedSession ? '会话已保护，不会参与空闲清理' : '已取消会话保护');
    } catch (error) {
      globalThis.LumenDiagnostics.report('会话保护', error);
      showToast('无法更新会话保护状态');
    }
  }

  function updateTabPinControl(session) {
    if (!session?.tab) return;
    session.tab.classList.toggle('is-pinned', session.pinned);
    const button = session.tab.querySelector('.close-tab');
    button.classList.toggle('is-pin', session.pinned);
    button.title = session.pinned ? '取消固定标签' : '关闭或结束终端';
    button.setAttribute('aria-label', session.pinned ? `取消固定 ${session.name}` : `关闭或结束 ${session.name}`);
    button.innerHTML = session.pinned
      ? '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.2h4M4.7 2.2v2L3.6 6h4.8L7.3 4.2v-2M6 6v3.8"/></svg>'
      : '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9"/></svg>';
    session.tab.dataset.sessionTitle = session.pinned
      ? `${session.name} · 已固定` : session.remoteTitle || session.name;
  }

  function setSessionReadOnly(session, readOnly) {
    session.readOnly = Boolean(readOnly);
    session.tab.classList.toggle('is-readonly', session.readOnly);
    session.tab.dataset.readonly = session.readOnly ? 'true' : 'false';
    session.tab.setAttribute('aria-description',
      session.readOnly ? '只读连接，键盘输入不会发送到会话' : '可交互连接');
    session.modeNotice.hidden = !session.readOnly;
    session.tab.querySelector('.connection-dot').title =
      session.readOnly ? '只读连接' : '可交互连接';
    if (session.socket && session.socket.readyState < WebSocket.CLOSING) {
      session.socket.close(1000, 'connection mode changed');
    } else {
      session.reconnectAttempts = 0;
      scheduleReconnect(session);
    }
    showToast(session.readOnly ? '已切换为只读连接' : '已恢复终端输入');
  }

  function claimSessionSize(session) {
    if (session.readOnly) {
      showToast('只读连接不能接管终端尺寸');
      return;
    }
    sendInput(session, '\x1b]777;lumen-claim-size\x07');
    scheduleResize(session);
    showToast('当前连接已接管终端尺寸');
    setTimeout(() => void refreshSessionInventory(), 250);
  }

  function closeSessionDialog() {
    if (sessionActionPending) return;
    sessionDialog.close();
    pendingCloseId = null;
    pendingForceTerminate = false;
  }

  async function terminateSession(id) {
    const session = sessions.get(id);
    if (sessionActionPending) return;
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
          'X-Lumen-Action': pendingForceTerminate ? 'terminate-force' : 'terminate',
        },
      });
      if (response.status === 401 || response.redirected) {
        window.location.assign(`${basePath}/login`);
        return;
      }
      if (response.status === 409) {
        pendingForceTerminate = true;
        sessionDialogDescription.textContent =
          `${session?.name || id} 已被设为受保护会话。请再次确认是否强制结束。`;
        sessionTerminate.querySelector('span').textContent = '仍要结束受保护会话';
        sessionDialog.classList.add('is-protected-warning');
        showToast('此会话受保护，需要再次确认');
        return;
      }
      if (!response.ok && response.status !== 404) {
        throw new Error(`terminate endpoint returned ${response.status}`);
      }
      void globalThis.LumenTerminalState.remove(id);

      if (sessionDialog.open) sessionDialog.close();
      pendingCloseId = null;
      pendingForceTerminate = false;
      if (!session) {
        showToast('终端会话及其中程序已结束');
        void refreshSessionInventory();
      } else if (sessions.size > 1) {
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
      label.textContent = pendingForceTerminate && sessionDialog.open
        ? '仍要结束受保护会话' : originalLabel;
      sessionTerminate.disabled = false;
      sessionCancel.disabled = false;
      if (sessionDialog.open) sessionDetach.disabled = sessions.size === 1;
    }
  }

  function addSession(workingDirectory = null) {
    if (sessions.size >= MAX_TABS) {
      showToast(`轻量模式最多同时打开 ${MAX_TABS} 个终端`);
      return;
    }
    const meta = nextTab();
    if (meta) {
      const current = sessions.get(activeId);
      meta.workingDirectory = typeof workingDirectory === 'string'
        ? workingDirectory
        : settings.inheritWorkingDirectory
          ? current?.currentWorkingDirectory || settings.workingDirectory
          : settings.workingDirectory;
      createSession(meta, true);
    }
  }

  function addDefaultSession() {
    if (settings.defaultRootSession) void addRootSession();
    else addSession();
  }

  async function addRootSession() {
    if (sessions.size >= MAX_TABS) {
      showToast(`轻量模式最多同时打开 ${MAX_TABS} 个终端`);
      return;
    }
    await refreshSessionInventory();
    const occupied = new Set([
      ...sessionInventory.filter(item => item.privileged === true).map(item => item.id),
      ...[...sessions.values()].filter(item => item.privileged).map(item => item.id),
    ]);
    let id = null;
    let methods;
    try {
      methods = await fetch(`${basePath}/api/privileged/methods`, {
        credentials: 'same-origin',
        cache: 'no-store',
      }).then(response => response.ok ? response.json() : Promise.reject(new Error('policy')));
      privilegedPolicy.maxSessions = Math.max(1, Math.min(8, Number(methods.maxSessions) || 2));
      privilegedPolicy.requireVerification = methods.requireVerification !== false;
    } catch {
      showToast('无法读取 root 会话安全策略');
      return;
    }
    for (let number = 1; number <= privilegedPolicy.maxSessions; number += 1) {
      if (!occupied.has(`root-${number}`)) {
        id = `root-${number}`;
        break;
      }
    }
    if (!id) {
      showToast(`最多同时保留 ${privilegedPolicy.maxSessions} 个 root 会话，请先结束一个`);
      return;
    }
    createSession({
      id,
      name: `root ${id.slice(5)}`,
      privileged: true,
      privilegedMode: 'create',
    }, true);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.querySelector('.app-shell').requestFullscreen();
    } catch (error) {
      console.warn('[lumen] fullscreen request failed', error);
      showToast('浏览器不允许进入页面全屏');
    }
  }

  function syncFullscreenState() {
    const fullscreen = Boolean(document.fullscreenElement);
    focusButton.title = fullscreen ? '退出页面全屏（Esc）' : '页面全屏';
    focusButton.setAttribute('aria-label', fullscreen ? '退出页面全屏' : '进入页面全屏');
    focusButton.setAttribute('aria-pressed', fullscreen ? 'true' : 'false');
    requestAnimationFrame(() => {
      const session = sessions.get(activeId);
      if (session) {
        scheduleResize(session);
        const primary = sessions.get(splitLayout.primaryId);
        if (primary && primary !== session) scheduleResize(primary);
        const secondary = sessions.get(splitLayout.secondaryId);
        if (secondary) scheduleResize(secondary);
        session.term.focus();
      }
    });
  }

  function applyTheme(theme, persist = true, restoreTerminalFocus = false) {
    currentTheme = theme;
    document.documentElement.dataset.theme = theme;
    if (persist) {
      localStorage.setItem(THEME_KEY, theme);
      preferencesDirty = true;
      if (preferencesReady) schedulePreferencesSave();
    }
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#10111a' : '#eff1f5';
    syncThemeToggle();
    for (const session of sessions.values()) {
      session.term.options.minimumContrastRatio = TERM_MINIMUM_CONTRAST[theme];
      session.term.options.theme = TERM_THEMES[theme];
      session.webglAddon?.clearTextureAtlas();
      session.term.refresh(0, Math.max(0, session.term.rows - 1));
      // A resize notification asks full-screen TUIs such as Codex to redraw
      // their semantic colors after the terminal background changes.
      scheduleResize(session);
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

  function syncThemeToggle() {
    const preference = followsSystemTheme ? 'system' : currentTheme;
    const labels = { system: '跟随设备', light: '浅色主题', dark: '深色主题' };
    const next = { system: 'light', light: 'dark', dark: 'system' }[preference];
    const description = `当前${labels[preference]}；切换到${labels[next]}`;
    themeButton.dataset.themePreference = preference;
    themeButton.title = description;
    themeButton.setAttribute('aria-label', description);
  }

  function setThemePreference(preference, restoreTerminalFocus = true) {
    followsSystemTheme = preference === 'system';
    if (followsSystemTheme) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, preference);
    applyTheme(followsSystemTheme
      ? systemThemeQuery.matches ? 'light' : 'dark'
      : preference, false, restoreTerminalFocus);
    setCustomSelect(themeSetting, preference);
    preferencesDirty = true;
    if (preferencesReady) schedulePreferencesSave();
  }

  function applyFontSize(fontSize) {
    settings.fontSize = fontSize;
    fontSizeSetting.value = String(fontSize);
    fontSizeValue.value = `${fontSize}px`;
    for (const session of sessions.values()) {
      session.term.options.fontSize = fontSize;
      session.webglAddon?.clearTextureAtlas();
      scheduleResize(session);
    }
  }

  function applyTerminalAppearance() {
    lineHeightValue.value = settings.lineHeight.toFixed(2);
    fontWeightValue.value = String(settings.fontWeight);
    letterSpacingValue.value = settings.letterSpacing.toFixed(1);
    scrollbackValue.value = `${settings.scrollback.toLocaleString()} 行`;
    for (const session of sessions.values()) {
      session.term.options.cursorStyle = settings.cursorStyle;
      session.term.options.lineHeight = settings.lineHeight;
      session.term.options.fontFamily = terminalFontFamily();
      session.term.options.fontWeight = String(settings.fontWeight);
      session.term.options.fontWeightBold = String(Math.min(700, settings.fontWeight + 200));
      session.term.options.letterSpacing = settings.letterSpacing;
      session.term.options.scrollback = settings.scrollback;
      session.webglAddon?.clearTextureAtlas();
      scheduleResize(session);
    }
    applyCursorBlink();
  }

  function applyCursorBlink() {
    const enabled = settings.cursorBlink;
    for (const session of sessions.values()) {
      session.term.options.cursorBlink = false;
      session.term.refresh(0, Math.max(0, session.term.rows - 1));
      if (!enabled) continue;
      requestAnimationFrame(() => {
        if (session.destroyed || !settings.cursorBlink) return;
        session.term.options.cursorBlink = true;
        session.term.refresh(0, Math.max(0, session.term.rows - 1));
      });
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
    const session = targetSession?.term ? targetSession : sessions.get(activeId);
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
    const isSplitMember = splitLayout.contains(session.id);
    const splitItems = isSplitMember
      ? [{
        label: '退出分屏',
        icon: 'unsplit',
        action: closeSplit,
      }]
      : [
        {
          label: '在右侧分屏',
          icon: 'split',
          disabled: sessions.size < 2 || session.id === activeId,
          action: () => toggleSplitSession(session, 'vertical'),
        },
        {
          label: '在下方分屏',
          icon: 'split',
          disabled: sessions.size < 2 || session.id === activeId,
          action: () => toggleSplitSession(session, 'horizontal'),
        },
      ];
    return [
      {
        label: '切换到此标签',
        icon: 'activate',
        disabled: session.id === activeId,
        action: () => activateSession(session.id),
      },
      { label: '重命名', icon: 'rename', action: () => beginRename(session) },
      {
        label: '在此目录新建终端',
        icon: 'add',
        action: () => addSession(session.currentWorkingDirectory || settings.workingDirectory),
      },
      {
        label: session.pinned ? '取消固定' : '固定标签',
        icon: session.pinned ? 'unpin' : 'pin',
        action: () => setSessionPinned(session, !session.pinned),
      },
      { separator: true },
      ...(!session.privileged ? [{
        label: session.protected ? '取消保护会话' : '保护会话',
        icon: session.protected ? 'unprotect' : 'protect',
        action: () => void setSessionProtected(session.id, !session.protected),
      }] : []),
      {
        label: session.readOnly ? '恢复终端输入' : '切换为只读',
        icon: session.readOnly ? 'writable' : 'readonly',
        action: () => setSessionReadOnly(session, !session.readOnly),
      },
      {
        label: '接管终端尺寸',
        icon: 'activate',
        disabled: session.readOnly || session.state !== 'online',
        action: () => claimSessionSize(session),
      },
      { separator: true },
      ...splitItems,
      { separator: true },
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
      { label: '新建 root 会话', icon: 'protect', danger: true, action: () => void addRootSession() },
      { separator: true },
      {
        label: '管理会话',
        icon: 'sessions',
        action: () => {
          openSettings();
          activateSettingsTab('sessions');
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

  async function refreshSessionInventory() {
    try {
      const response = await fetch(`${basePath}/api/sessions`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`session list returned ${response.status}`);
      const inventory = await response.json();
      if (!Array.isArray(inventory)) throw new Error('invalid session list');
      sessionInventory = inventory;
      sessionInventoryUpdatedAt = Date.now();
      const byId = new Map(inventory.map(item => [item.id, item]));
      let privilegeStateChanged = false;
      for (const session of sessions.values()) {
        const item = byId.get(session.id);
        const count = Number(item?.clients || 0);
        if (item && session.privileged !== (item.privileged === true)) {
          session.privileged = item.privileged === true;
          privilegeStateChanged = true;
        }
        session.protected = !session.privileged && Boolean(item?.protected);
        session.backend = item?.backend || 'tmux-legacy';
        session.tab.classList.toggle('is-privileged', session.privileged);
        const rootBadge = session.tab.querySelector('.root-badge');
        if (rootBadge) rootBadge.hidden = !session.privileged;
        session.tab.classList.toggle('is-protected', session.protected);
        session.tab.querySelector('.tab-protection').hidden = !session.protected;
        const legacyBadge = session.tab.querySelector('.legacy-backend-badge');
        if (legacyBadge) legacyBadge.hidden = session.backend !== 'tmux-legacy';
        session.connections.textContent = count > 9 ? '9+' : String(count);
        session.connections.hidden = count < 2;
        session.connections.title = `当前 ${count} 个连接`;
      }
      if (privilegeStateChanged) saveState();
      if (activeSettingsTab === 'sessions' && settingsDialog.open) {
        renderIdleCleanupPreview();
        renderSessionManager();
      }
      return inventory;
    } catch (error) {
      console.warn('[lumen] could not refresh sessions', error);
      return null;
    }
  }

  function renderSessionManager() {
    if (sessionManagerList.contains(document.activeElement)
        && document.activeElement.classList.contains('session-note-input')) return;
    sessionManagerList.replaceChildren();
    if (!sessionInventory.length) {
      sessionManagerList.innerHTML = '<div class="session-manager-loading">当前没有后台会话</div>';
      updateSessionBulkActions();
      return;
    }
    const query = sessionManagerSearch.value.trim().toLocaleLowerCase();
    const visibleItems = sessionInventory.filter(item => {
      const session = sessions.get(item.id);
      const matchesQuery = `${session?.name || ''} ${item.id} ${settings.sessionNotes[item.id] || ''}`
        .toLocaleLowerCase().includes(query);
      const matchesStatus = sessionStatus === 'all'
        || sessionStatus === 'connected' && Number(item.clients) > 0
        || sessionStatus === 'idle' && Number(item.clients) === 0
        || sessionStatus === 'protected' && item.protected
        || sessionStatus === 'worker' && item.backend === 'worker'
        || sessionStatus === 'tmux-legacy' && item.backend === 'tmux-legacy';
      return matchesQuery && matchesStatus;
    }).sort((left, right) => {
      if (sessionSort === 'created-asc') return Number(left.createdAt) - Number(right.createdAt);
      if (sessionSort === 'name') {
        return (sessions.get(left.id)?.name || left.id)
          .localeCompare(sessions.get(right.id)?.name || right.id, 'zh-CN');
      }
      if (sessionSort === 'connections') return Number(right.clients) - Number(left.clients);
      return Number(right.createdAt) - Number(left.createdAt);
    });
    if (!visibleItems.length) {
      sessionManagerList.innerHTML = '<div class="session-manager-loading">没有匹配的会话</div>';
      updateSessionBulkActions();
      return;
    }
    for (const item of visibleItems) {
      const session = sessions.get(item.id);
      const row = document.createElement('div');
      row.className = 'session-manager-row';
      row.dataset.sessionId = item.id;
      const body = document.createElement('div');
      body.className = 'session-manager-body';
      const selection = document.createElement('label');
      selection.className = 'session-selection';
      selection.innerHTML = '<input type="checkbox"><i aria-hidden="true"></i>';
      const selectionInput = selection.querySelector('input');
      selectionInput.checked = selectedSessionIds.has(item.id);
      selectionInput.addEventListener('change', () => {
        if (selectionInput.checked) selectedSessionIds.add(item.id);
        else selectedSessionIds.delete(item.id);
        updateSessionBulkActions();
      });
      const copy = document.createElement('span');
      copy.className = 'session-manager-summary';
      copy.innerHTML = '<strong></strong><small></small><small class="session-runtime"></small>';
      const title = copy.querySelector('strong');
      title.textContent = session?.name || item.id;
      if (item.privileged === true) {
        const rootBadge = document.createElement('span');
        rootBadge.className = 'session-root-badge';
        rootBadge.textContent = 'ROOT';
        title.append(rootBadge);
        const rootPolicyBadge = document.createElement('span');
        rootPolicyBadge.className = 'session-root-policy-badge';
        rootPolicyBadge.textContent = '强制回收';
        rootPolicyBadge.title = 'root 会话不支持保护，并始终受空闲回收策略约束';
        title.append(rootPolicyBadge);
      }
      const countBadge = document.createElement('span');
      countBadge.className = 'session-count-badge';
      countBadge.textContent = `${item.clients} 个连接`;
      title.append(countBadge);
      if (item.protected) {
        const protectedBadge = document.createElement('span');
        protectedBadge.className = 'session-protected-badge';
        protectedBadge.textContent = '受保护';
        title.append(protectedBadge);
      }
      if (item.backend === 'tmux-legacy') {
        const legacyBadge = document.createElement('span');
        legacyBadge.className = 'session-legacy-badge';
        legacyBadge.textContent = '旧版 tmux';
        legacyBadge.title = '此会话会继续保留，直到其中的 shell 自然结束';
        title.append(legacyBadge);
      }
      const createdAt = Number(item.createdAt || 0) * 1000;
      copy.querySelector('small').textContent =
        `${item.id} · ${item.backend === 'worker' ? '原生 PTY' : '旧版 tmux'} · 创建于 ${formatDateTime(createdAt)} · PID ${item.pid} · ${item.rows}×${item.columns}`;
      const memory = Number(item.memoryKb || 0);
      copy.querySelector('.session-runtime').textContent = [
        item.foregroundCommand ? `前台 ${item.foregroundCommand} (${item.foregroundPid})` : '',
        item.workingDirectory || '',
        memory ? `内存 ${(memory / 1024).toFixed(memory >= 10240 ? 0 : 1)} MiB` : '',
        `CPU ${Number(item.cpuPercent || 0).toFixed(1)}%`,
      ].filter(Boolean).join(' · ');
      const note = document.createElement('input');
      note.className = 'session-note-input';
      note.type = 'text';
      note.maxLength = 160;
      note.placeholder = '添加备注';
      note.value = settings.sessionNotes[item.id] || '';
      const saveNote = () => {
        const value = note.value.trim().slice(0, 160);
        if (value) settings.sessionNotes[item.id] = value;
        else delete settings.sessionNotes[item.id];
        saveSettings();
        sessionNoteSaveTimers.delete(item.id);
      };
      note.addEventListener('input', () => {
        clearTimeout(sessionNoteSaveTimers.get(item.id));
        sessionNoteSaveTimers.set(item.id, setTimeout(saveNote, 600));
      });
      note.addEventListener('change', () => {
        clearTimeout(sessionNoteSaveTimers.get(item.id));
        saveNote();
      });
      const activate = document.createElement('button');
      activate.type = 'button';
      activate.textContent = session ? '切换' : '附加';
      activate.addEventListener('click', () => {
        settingsDialog.close();
        if (session) activateSession(session.id);
        else createSession({
          id: item.id,
          name: item.id,
          privileged: item.privileged === true,
        }, true);
      });
      const terminate = document.createElement('button');
      terminate.type = 'button';
      terminate.className = 'danger';
      terminate.textContent = '结束';
      terminate.addEventListener('click', () => {
        settingsDialog.close();
        openSessionDialog(item.id, session?.name || item.id);
      });
      const actions = document.createElement('span');
      actions.className = 'session-manager-actions';
      const copyInfo = document.createElement('button');
      copyInfo.type = 'button';
      copyInfo.textContent = '复制';
      copyInfo.addEventListener('click', () => {
        const text = [
          `会话: ${session?.name || item.id} (${item.id})`,
          `创建: ${formatDateTime(createdAt)}`,
          `连接: ${item.clients}`,
          `前台进程: ${item.foregroundCommand || '-'} (${item.foregroundPid || '-'})`,
          `工作目录: ${item.workingDirectory || '-'}`,
          `终端尺寸: ${item.columns}×${item.rows}`,
          `内存: ${item.memoryKb || 0} KiB`,
        ].join('\n');
        void writeSystemClipboard(text, true, true);
      });
      actions.append(activate, copyInfo);
      if (item.privileged !== true) {
        const protect = document.createElement('button');
        protect.type = 'button';
        protect.textContent = item.protected ? '取消保护' : '保护';
        protect.addEventListener('click', () => void setSessionProtected(item.id, !item.protected));
        actions.append(protect);
      }
      actions.append(terminate);
      const connections = document.createElement('div');
      connections.className = 'session-connections';
      const connectionItems = Array.isArray(item.connections) ? item.connections : [];
      if (!connectionItems.length) {
        connections.innerHTML = '<div class="session-connection-empty">当前没有活动连接</div>';
      }
      for (const connection of connectionItems) {
        const isCurrent = isCurrentConnection(session, connection);
        const connectedAt = Number(connection.connectedAt || 0) * 1000;
        const detail = document.createElement('div');
        detail.className = 'session-connection-row';
        detail.classList.toggle('is-current', isCurrent);
        const info = document.createElement('span');
        info.innerHTML = '<strong></strong><small></small>';
        const connectionTitle = info.querySelector('strong');
        connectionTitle.textContent = connection.ip || '未知地址';
        if (isCurrent) {
          const badge = document.createElement('em');
          badge.className = 'current-connection-badge';
          badge.textContent = '当前连接';
          connectionTitle.append(badge);
        }
        if (connection.sizeOwner) {
          const badge = document.createElement('em');
          badge.className = 'current-connection-badge size-owner-badge';
          badge.textContent = '尺寸控制';
          connectionTitle.append(badge);
        }
        if (connection.readOnly) {
          const badge = document.createElement('em');
          badge.className = 'current-connection-badge readonly-connection-badge';
          badge.textContent = '只读';
          connectionTitle.append(badge);
        }
        info.querySelector('small').textContent =
          `连接于 ${formatDateTime(connectedAt)} · 已连接 ${formatDuration(Date.now() - connectedAt)} · ${connection.rows}×${connection.columns}`;
        const disconnect = document.createElement('button');
        disconnect.type = 'button';
        disconnect.className = 'danger subtle';
        disconnect.textContent = '断开';
        disconnect.addEventListener('click', () => {
          pendingConnection = {
            sessionId: item.id,
            connectionId: connection.id,
            ip: connection.ip,
            isCurrent,
          };
          connectionDialogDescription.textContent =
            isCurrent
              ? '这是当前页面的连接。断开后此标签将离线，刷新页面可以重新连接；后台终端和任务不会终止。'
              : `将立即断开 ${connection.ip || '未知地址'} 的浏览器连接，后台终端和其中运行的任务不会终止。`;
          connectionDialog.showModal();
          requestAnimationFrame(() => connectionDisconnectCancel.focus());
        });
        detail.append(info, disconnect);
        connections.append(detail);
      }
      body.append(copy, note, connections);
      row.append(selection, body, actions);
      sessionManagerList.append(row);
    }
    updateSessionBulkActions();
  }

  function updateSessionBulkActions() {
    for (const id of [...selectedSessionIds]) {
      if (!sessionInventory.some(item => item.id === id)) selectedSessionIds.delete(id);
    }
    const selected = sessionInventory.filter(item => selectedSessionIds.has(item.id));
    const protectable = selected.filter(item => item.privileged !== true);
    sessionSelectionCount.textContent = selected.length ? `已选择 ${selected.length} 个会话` : '未选择会话';
    document.getElementById('protect-selected-sessions').disabled = !protectable.length;
    document.getElementById('unprotect-selected-sessions').disabled = !protectable.length;
    document.getElementById('terminate-selected-sessions').disabled =
      !selected.some(item => Number(item.clients) === 0 && !item.protected);
  }

  async function setSelectedSessionsProtected(protectedSession) {
    const ids = sessionInventory
      .filter(item => selectedSessionIds.has(item.id) && item.privileged !== true)
      .map(item => item.id);
    for (const id of ids) await setSessionProtected(id, protectedSession, true);
    showToast(`已${protectedSession ? '保护' : '取消保护'} ${ids.length} 个会话`);
  }

  async function disconnectManagedConnection() {
    if (!pendingConnection) return;
    connectionDisconnectConfirm.disabled = true;
    connectionDisconnectCancel.disabled = true;
    try {
      const { sessionId, connectionId } = pendingConnection;
      const response = await fetch(
        `${basePath}/api/sessions/${encodeURIComponent(sessionId)}/connections/${encodeURIComponent(connectionId)}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'X-Lumen-Action': 'disconnect' },
        },
      );
      if (response.status === 401 || response.redirected) {
        window.location.assign(`${basePath}/login`);
        return;
      }
      if (!response.ok && response.status !== 404) throw new Error(`disconnect returned ${response.status}`);
      connectionDialog.close();
      showToast(response.status === 404 ? '连接已经断开' : '连接已断开，后台任务仍在运行');
      await refreshSessionInventory();
    } catch (error) {
      console.error('[lumen] failed to disconnect client', error);
      showToast('无法断开连接，请稍后重试');
    } finally {
      pendingConnection = null;
      connectionDisconnectConfirm.disabled = false;
      connectionDisconnectCancel.disabled = false;
    }
  }

  function loadSessionManager() {
    sessionManagerList.innerHTML = '<div class="session-manager-loading">正在读取会话…</div>';
    renderIdleCleanupPreview();
    void refreshSessionInventory();
  }

  function idleSessionCandidates() {
    const cutoff = Date.now() / 1000 - settings.idleCleanupSeconds;
    return sessionInventory.filter(item =>
      !item.protected && Number(item.clients) === 0
      && Number(item.lastActivityAt || item.createdAt) < cutoff);
  }

  function cleanupResourceSummary(candidates) {
    const kib = candidates.reduce((sum, item) =>
      sum + Number(item.memoryKb || 0) + Number(item.historyBytes || 0) / 1024, 0);
    return {
      count: candidates.length,
      mib: kib / 1024,
    };
  }

  function idleThresholdLabel() {
    if (settings.idleCleanupSeconds < 3600) return `${settings.idleCleanupSeconds / 60} 分钟`;
    return `${settings.idleCleanupSeconds / 3600} 小时`;
  }

  function renderIdleCleanupPreview() {
    const summary = cleanupResourceSummary(idleSessionCandidates());
    const protectedCount = sessionInventory.filter(item => item.protected).length;
    cleanupIdleSessionsButton.disabled = summary.count === 0;
    cleanupIdleSessionsButton.textContent = summary.count ? `清理空闲 · ${summary.count}` : '清理空闲';
    idleCleanupPreview.textContent = summary.count
      ? `当前有 ${summary.count} 个零连接会话超过 ${idleThresholdLabel()}，预计释放约 ${summary.mib.toFixed(1)} MiB 已统计资源${protectedCount ? `；已排除 ${protectedCount} 个受保护会话` : ''}`
      : `当前没有零连接会话超过 ${idleThresholdLabel()}${protectedCount ? `；已排除 ${protectedCount} 个受保护会话` : ''}`;
  }

  function openIdleCleanup(candidatesOverride = null) {
    const candidates = candidatesOverride || idleSessionCandidates();
    if (!candidates.length) {
      showToast(`没有超过 ${idleThresholdLabel()}且无人连接的空闲会话`);
      return;
    }
    const summary = cleanupResourceSummary(candidates);
    idleCleanupDescription.textContent =
      `以下会话已超过 ${idleThresholdLabel()}没有活动且当前无人连接。结束后无法恢复。`;
    idleCleanupSummary.textContent =
      `${summary.count} 个会话 · 预计释放约 ${summary.mib.toFixed(1)} MiB 已统计内存与历史缓存`;
    idleCleanupList.replaceChildren(...candidates.map(item => {
      const row = document.createElement('div');
      row.className = 'idle-cleanup-row';
      const name = sessions.get(item.id)?.name || item.id;
      const minutes = Math.floor((Date.now() / 1000 - Number(item.lastActivityAt || item.createdAt)) / 60);
      row.innerHTML = '<strong></strong><small></small>';
      row.querySelector('strong').textContent = name;
      row.querySelector('small').textContent = `${item.id} · 已空闲 ${minutes} 分钟`;
      return row;
    }));
    pendingCleanupCandidates = candidates;
    idleCleanupDialog.showModal();
  }

  async function cleanupIdleSessions() {
    const candidates = pendingCleanupCandidates || idleSessionCandidates();
    idleCleanupConfirm.disabled = true;
    try {
      for (const item of candidates) {
        const response = await fetch(`${basePath}/api/sessions/${encodeURIComponent(item.id)}`, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'X-Lumen-Action': 'terminate' },
        });
        if (!response.ok && response.status !== 404) throw new Error(`terminate ${item.id}: ${response.status}`);
      }
      idleCleanupDialog.close();
      pendingCleanupCandidates = null;
      for (const item of candidates) selectedSessionIds.delete(item.id);
      showToast(`已清理 ${candidates.length} 个空闲会话`);
      await refreshSessionInventory();
    } catch (error) {
      globalThis.LumenDiagnostics.report('会话清理', error);
      showToast('空闲会话清理未能全部完成');
    } finally {
      idleCleanupConfirm.disabled = false;
    }
  }

  function renderDiagnostics() {
    const entries = filteredDiagnostics();
    diagnosticsCount.textContent = `${entries.length} 条异常`;
    diagnosticsList.replaceChildren();
    if (!entries.length) {
      diagnosticsList.innerHTML = '<div class="session-manager-loading">暂无异常</div>';
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('article');
      row.className = 'diagnostic-row';
      row.innerHTML = '<span class="diagnostic-source"></span><span><strong></strong><small></small></span><time></time>';
      row.querySelector('.diagnostic-source').textContent = entry.source;
      row.querySelector('strong').textContent = entry.message;
      row.querySelector('small').textContent = entry.count > 1 ? `重复 ${entry.count} 次` : '首次出现';
      row.querySelector('time').textContent = formatDateTime(entry.timestamp);
      diagnosticsList.append(row);
    }
  }

  function filteredDiagnostics() {
    return globalThis.LumenDiagnostics.filter(diagnosticsSource);
  }

  function diagnosticsJson() {
    return globalThis.LumenDiagnostics.serialize(diagnosticsSource);
  }

  function exportDiagnostics() {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([diagnosticsJson()], {
      type: 'application/json;charset=utf-8',
    }));
    link.download = `lumen-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  }

  function formatResourceBytes(value) {
    const bytes = Number(value || 0);
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }

  async function refreshServiceHealth(showLoading = true) {
    if (showLoading) serviceHealthGrid.innerHTML = '<div class="session-manager-loading">正在读取服务状态…</div>';
    try {
      const response = await fetch(`${basePath}/api/health`, {
        credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`health returned ${response.status}`);
      const health = await response.json();
      const memoryPercent = Number(health.memory?.totalBytes)
        ? Number(health.memory.usedBytes) / Number(health.memory.totalBytes) * 100 : 0;
      const diskPercent = Number(health.disk?.totalBytes)
        ? Number(health.disk.usedBytes) / Number(health.disk.totalBytes) * 100 : 0;
      const resourceStatus = percent => percent >= 95 ? 'critical' : percent >= 85 ? 'warning' : 'ok';
      const diskStatus = diskPercent >= 90 ? 'critical' : diskPercent >= 80 ? 'warning' : 'ok';
      const ptyLatency = Number(health.pty?.latencyMs || 0);
      const ptyStatus = ptyLatency >= 1000 ? 'critical' : ptyLatency >= 200 ? 'warning' : health.pty?.status;
      const recentError = globalThis.LumenDiagnostics.list()[0] || null;
      health.frontend = {
        reconnects: websocketReconnectCount,
        latestError: recentError,
        userAgent: navigator.userAgent,
        capturedAt: new Date().toISOString(),
      };
      latestHealthReport = health;
      const cards = [
        { name: 'Web', status: health.web?.status, detail: `运行 ${formatDuration(Number(health.web?.uptimeSeconds || 0) * 1000)} · 内存 ${(Number(health.web?.memoryKb || 0) / 1024).toFixed(1)} MiB` },
        { name: 'PTY', status: ptyStatus, detail: `${Number(health.pty?.workerSessions || 0)} 个原生 · ${Number(health.pty?.legacySessions || 0)} 个旧版 · 响应 ${ptyLatency} ms` },
        { name: 'WebSocket', status: websocketReconnectCount >= 20 ? 'critical' : websocketReconnectCount >= 5 ? 'warning' : health.websocket?.status, detail: `${Number(health.websocket?.connections || 0)} 个活动连接 · 本页重连 ${websocketReconnectCount} 次` },
        { name: '迁移状态', status: health.tmux?.status, detail: `${Number(health.tmux?.sessions || 0)} 个旧版 tmux 会话${Number(health.tmux?.sessions || 0) ? '仍在自然运行' : ' · 已可移除 tmux'}` },
        { name: '主机内存', status: resourceStatus(memoryPercent), detail: `${formatResourceBytes(health.memory?.usedBytes)} / ${formatResourceBytes(health.memory?.totalBytes)}`, percent: memoryPercent },
        { name: '磁盘', status: diskStatus, detail: `${formatResourceBytes(health.disk?.usedBytes)} / ${formatResourceBytes(health.disk?.totalBytes)}`, percent: diskPercent },
      ];
      const severity = cards.some(card => card.status === 'critical' || card.status === 'error')
        ? 'critical' : cards.some(card => card.status === 'warning') ? 'warning' : 'ok';
      settingsButton.classList.toggle('has-health-warning', severity !== 'ok');
      settingsButton.dataset.healthStatus = severity;
      serviceHealthSummary.textContent =
        `${severity === 'ok' ? '所有服务正常' : severity === 'warning' ? '检测到资源预警' : '检测到服务异常'} · 每 3 秒自动刷新`
        + (recentError ? ` · 最近异常 ${formatDateTime(recentError.timestamp)}` : '');
      serviceHealthGrid.replaceChildren(...cards.map(cardData => {
        const card = document.createElement('article');
        card.className = 'service-health-card';
        card.dataset.status = cardData.status || 'unknown';
        card.innerHTML = '<span class="health-dot"></span><span><strong></strong><small></small><i class="health-progress"><i></i></i></span><b></b>';
        card.querySelector('strong').textContent = cardData.name;
        card.querySelector('small').textContent = cardData.detail;
        const progress = card.querySelector('.health-progress');
        progress.hidden = cardData.percent == null;
        progress.firstElementChild.style.width = `${Math.min(100, cardData.percent || 0)}%`;
        card.querySelector('b').textContent =
          cardData.status === 'ok' ? '正常' : cardData.status === 'idle' ? '空闲'
            : cardData.status === 'warning' ? '预警' : '异常';
        return card;
      }));
      renderDependencyChecks(health.dependencies || {});
    } catch (error) {
      settingsButton.classList.add('has-health-warning');
      settingsButton.dataset.healthStatus = 'critical';
      globalThis.LumenDiagnostics.report('服务健康', error);
      if (activeSettingsTab === 'health' && settingsDialog.open)
        serviceHealthGrid.innerHTML = '<div class="session-manager-loading">无法读取服务状态</div>';
      if (activeSettingsTab === 'dependencies' && settingsDialog.open) {
        dependencySummary.textContent = '无法读取依赖状态';
        dependencyGrid.innerHTML = '<div class="session-manager-loading">依赖检查请求失败</div>';
      }
    }
  }

  function renderDependencyChecks(status) {
    const checks = [
      { key: 'ptyClient', name: 'PTY 客户端', detail: 'Web 服务连接持久终端所需的 lumen-pty', required: true },
      { key: 'normalPtySocket', name: '普通 PTY', detail: '普通用户会话的 Unix Socket', required: true },
      { key: 'rootPtySocket', name: 'Root PTY', detail: '特权会话的隔离 Unix Socket', required: true },
      { key: 'tmux', name: 'tmux', detail: '持久会话与进程恢复', required: true },
      { key: 'shell', name: '默认 Shell', detail: '创建交互式终端所需的登录 Shell', required: true },
      { key: 'websockets', name: 'libwebsockets', detail: 'HTTP 与 WebSocket 传输层（内置）', required: true },
      { key: 'openssl', name: 'OpenSSL', detail: '密码散列、会话和安全随机数（内置）', required: true },
      { key: 'fido2', name: 'libfido2', detail: '通行密钥与 WebAuthn 支持（内置）', required: true },
      { key: 'qrencode', name: 'libqrencode', detail: 'TOTP 二维码生成（内置）', required: true },
      { key: 'bubblewrap', name: 'bubblewrap', detail: 'Codex Linux 沙箱的可选运行依赖', required: false },
      { key: 'userNamespaces', name: 'User Namespace', detail: 'bubblewrap 创建隔离沙箱所需的内核能力', required: false },
    ].map(item => ({ ...item, available: status[item.key] === true }));
    const missingRequired = checks.filter(item => item.required && !item.available);
    const missingOptional = checks.filter(item => !item.required && !item.available);
    dependencySummary.textContent = missingRequired.length
      ? `${missingRequired.length} 项必要依赖异常`
      : missingOptional.length
        ? `必要依赖正常 · ${missingOptional.length} 项可选能力不可用`
        : '所有运行依赖和可选能力均正常';
    dependencyGrid.replaceChildren(...checks.map(item => {
      const card = document.createElement('article');
      card.className = 'dependency-card';
      card.dataset.status = item.available ? 'ok' : item.required ? 'error' : 'warning';
      card.innerHTML = '<i class="health-dot"></i><span><strong></strong><small></small></span><b></b>';
      card.querySelector('strong').textContent = item.name;
      card.querySelector('small').textContent = item.detail;
      card.querySelector('b').textContent = item.available ? '可用' : item.required ? '缺失' : '未启用';
      return card;
    }));
  }

  function copyServiceDiagnostics() {
    if (!latestHealthReport) {
      showToast('健康数据尚未加载');
      return;
    }
    const copied = copyWithSelection(JSON.stringify({
      health: latestHealthReport,
      diagnostics: globalThis.LumenDiagnostics.list(),
    }, null, 2));
    showToast(copied ? '诊断信息已复制' : '无法复制诊断信息');
  }

  function renderAuditLog() {
    const query = auditLogSearch.value.trim().toLocaleLowerCase();
    const entries = filterAuditEntries(auditEntries, {
      query,
      category: auditEventCategory,
      range: auditTimeRange,
    });
    const sensitive = entries.filter(entry =>
      ['login_failed', 'login_locked', 'session_terminated', 'connection_disconnected',
        'passkey_deleted', 'totp_removed'].includes(entry.event)).length;
    auditLogCount.textContent = `${entries.length} 条记录${sensitive ? ` · ${sensitive} 条敏感事件` : ''}`;
    auditLogList.replaceChildren();
    if (!entries.length) {
      auditLogList.innerHTML = '<div class="session-manager-loading">没有匹配的审计记录</div>';
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const row = document.createElement('article');
      row.className = 'audit-log-row';
      row.dataset.event = entry.event;
      const marker = document.createElement('span');
      marker.className = 'audit-log-marker';
      const body = document.createElement('span');
      body.className = 'audit-log-body';
      const title = document.createElement('strong');
      title.textContent = AUDIT_EVENT_LABELS[entry.event] || entry.event;
      const detail = document.createElement('small');
      detail.textContent = entry.detail && entry.detail !== '-' ? entry.detail : '无附加详情';
      body.append(title, detail);
      const meta = document.createElement('span');
      meta.className = 'audit-log-meta';
      const time = Date.parse(entry.timestamp);
      const timeNode = document.createElement('time');
      timeNode.dateTime = entry.timestamp;
      timeNode.textContent = Number.isFinite(time) ? formatDateTime(time) : entry.timestamp;
      const client = document.createElement('code');
      client.textContent = entry.client || '未知来源';
      meta.append(timeNode, client);
      row.append(marker, body, meta);
      fragment.append(row);
    }
    auditLogList.append(fragment);
  }

  async function refreshAuditLog() {
    auditLogList.innerHTML = '<div class="session-manager-loading">正在读取审计日志…</div>';
    refreshAuditLogButton.disabled = true;
    try {
      const response = await fetch(`${basePath}/api/audit-log`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (response.status === 401 || response.redirected) {
        window.location.assign(`${basePath}/login`);
        return;
      }
      if (!response.ok) throw new Error(`audit log returned ${response.status}`);
      const result = await response.json();
      auditEntries = Array.isArray(result) ? result : Array.isArray(result.entries) ? result.entries : [];
      const policy = Array.isArray(result) ? null : result.policy;
      auditRetentionPolicy.textContent = policy
        ? `轮转策略：单文件 ${(Number(policy.maxBytes) / 1024 / 1024).toFixed(0)} MiB，保留 ${Number(policy.retentionFiles)} 份历史文件`
        : '轮转策略暂不可用';
      renderAuditLog();
    } catch (error) {
      console.warn('[lumen] could not read audit log', error);
      auditLogList.innerHTML = '<div class="session-manager-loading">无法读取审计日志</div>';
    } finally {
      refreshAuditLogButton.disabled = false;
    }
  }

  function exportAuditLog(format) {
    const content = serializeAuditEntries(auditEntries, format);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([content], {
      type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8',
    }));
    link.download = `lumen-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  }

  function renderCommandSnippets() {
    commandSnippetList.replaceChildren();
    if (!settings.commandSnippets.length) {
      commandSnippetList.innerHTML = '<div class="session-manager-loading">还没有命令片段</div>';
      return;
    }
    for (const snippet of settings.commandSnippets) {
      const row = document.createElement('article');
      row.className = 'command-snippet-row';
      const content = document.createElement('span');
      content.innerHTML = '<strong></strong><code></code>';
      content.querySelector('strong').textContent = snippet.name;
      content.querySelector('code').textContent = snippet.command;
      const actions = document.createElement('span');
      const send = document.createElement('button');
      send.type = 'button';
      send.textContent = snippet.run ? '发送并执行' : '发送';
      send.addEventListener('click', () => {
        const session = sessions.get(activeId);
        if (!session || session.readOnly) {
          showToast(session?.readOnly ? '当前终端处于只读模式' : '没有可用的终端');
          return;
        }
        const execute = () => {
          sendInput(session, snippet.command + (snippet.run ? '\r' : ''));
          settingsDialog.close();
          session.term.focus();
        };
        const looksDangerous = snippet.run && isDangerousSnippet(snippet.command);
        if (looksDangerous) {
          showToast('此片段包含可能破坏数据的命令', 12000, {
            label: '仍然执行',
            handler: execute,
          });
          return;
        }
        execute();
      });
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = '编辑';
      edit.addEventListener('click', () => openSnippetEditor(snippet));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger';
      remove.textContent = '删除';
      remove.addEventListener('click', () => {
        settings.commandSnippets = settings.commandSnippets.filter(item => item.id !== snippet.id);
        saveSettings();
        renderCommandSnippets();
      });
      actions.append(send, edit, remove);
      row.append(content, actions);
      commandSnippetList.append(row);
    }
  }

  function openSnippetEditor(snippet = null) {
    editingSnippetId = snippet?.id || null;
    commandSnippetName.value = snippet?.name || '';
    commandSnippetCommand.value = snippet?.command || '';
    commandSnippetRun.checked = Boolean(snippet?.run);
    commandSnippetEditor.hidden = false;
    commandSnippetName.focus();
  }

  function closeSnippetEditor() {
    editingSnippetId = null;
    commandSnippetEditor.hidden = true;
    commandSnippetName.value = '';
    commandSnippetCommand.value = '';
    commandSnippetRun.checked = false;
  }

  function saveCommandSnippet() {
    const name = commandSnippetName.value.trim().slice(0, 40);
    const command = commandSnippetCommand.value.trim().slice(0, 2000);
    if (!name || !command) {
      showToast('请填写片段名称和命令');
      return;
    }
    const snippet = {
      id: editingSnippetId || crypto.randomUUID(),
      name,
      command,
      run: commandSnippetRun.checked,
    };
    settings.commandSnippets = upsertSnippet(settings.commandSnippets, snippet);
    saveSettings();
    closeSnippetEditor();
    renderCommandSnippets();
    showToast('命令片段已保存');
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
    setCustomSelect(themeSetting, followsSystemTheme ? 'system' : currentTheme);
    applyFontSize(settings.fontSize);
    setCustomSelect(fontFamilySetting, settings.fontFamily);
    fontWeightSetting.value = String(settings.fontWeight);
    fontWeightValue.value = String(settings.fontWeight);
    letterSpacingSetting.value = String(settings.letterSpacing);
    letterSpacingValue.value = settings.letterSpacing.toFixed(1);
    scrollbackSetting.value = String(settings.scrollback);
    scrollbackValue.value = `${settings.scrollback.toLocaleString()} 行`;
    setCustomSelect(cursorStyleSetting, settings.cursorStyle);
    cursorBlinkSetting.checked = settings.cursorBlink;
    lineHeightSetting.value = String(settings.lineHeight);
    lineHeightValue.value = settings.lineHeight.toFixed(2);
    workingDirectorySetting.value = settings.workingDirectory;
    inheritWorkingDirectorySetting.checked = settings.inheritWorkingDirectory;
    persistTerminalStateSetting.checked = settings.persistTerminalState;
    setCustomSelect(rootMaxSessionsSetting, String(settings.rootMaxSessions));
    defaultRootSessionSetting.checked = settings.defaultRootSession;
    rootRequireVerificationSetting.checked = settings.rootRequireVerification;
    setCustomSelect(idleCleanupThreshold, String(settings.idleCleanupSeconds));
    shortcutSearchSetting.value = settings.shortcuts.search;
    shortcutNewTabSetting.value = settings.shortcuts.newTab;
  }

  function openSettings() {
    hideContextMenu();
    syncSettingsControls();
    activateSettingsTab(activeSettingsTab);
    settingsDialog.showModal();
    requestAnimationFrame(() => settingsTabs.find(tab => tab.dataset.settingsTab === activeSettingsTab)?.focus());
  }

  function activateSettingsTab(name) {
    activeSettingsTab = settingsPanels.some(panel => panel.dataset.settingsPanel === name) ? name : 'general';
    for (const tab of settingsTabs) {
      tab.setAttribute('aria-selected', String(tab.dataset.settingsTab === activeSettingsTab));
    }
    for (const panel of settingsPanels) {
      panel.hidden = panel.dataset.settingsPanel !== activeSettingsTab;
    }
    if (activeSettingsTab === 'security') void refreshPasskeys();
    if (activeSettingsTab === 'security') void refreshTotpStatus();
    if (activeSettingsTab === 'sessions') loadSessionManager();
    if (activeSettingsTab === 'snippets') renderCommandSnippets();
    if (activeSettingsTab === 'audit') void refreshAuditLog();
    if (activeSettingsTab === 'diagnostics') renderDiagnostics();
    if (activeSettingsTab === 'health') void refreshServiceHealth();
    if (activeSettingsTab === 'dependencies') {
      dependencySummary.textContent = '正在检查运行环境…';
      dependencyGrid.innerHTML = '<div class="session-manager-loading">正在读取依赖状态…</div>';
      void refreshServiceHealth(false);
    }
  }

  function openPasskeyActionDialog(mode, item) {
    pendingPasskeyAction = { mode, item };
    const deleting = mode === 'delete';
    passkeyActionTitle.textContent = deleting ? '删除通行密钥' : '重命名通行密钥';
    passkeyActionDescription.textContent = deleting
      ? `删除“${item.name || '通行密钥'}”后，将无法再使用它登录。`
      : '设置一个便于识别设备或安全密钥的名称。';
    passkeyNameField.hidden = deleting;
    passkeyNameInput.value = deleting ? '' : (item.name || '');
    passkeyActionConfirm.textContent = deleting ? '确认删除' : '保存名称';
    passkeyActionConfirm.classList.toggle('danger', deleting);
    passkeyActionConfirm.disabled = false;
    passkeyActionDialog.showModal();
    requestAnimationFrame(() => (deleting ? passkeyActionConfirm : passkeyNameInput).focus());
  }

  function closePasskeyActionDialog() {
    pendingPasskeyAction = null;
    passkeyNameInput.value = '';
    passkeyActionDialog.close();
  }

  function renderPasskeys(items) {
    passkeyList.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'passkey-empty';
      empty.textContent = '还没有添加通行密钥';
      passkeyList.append(empty);
      return;
    }
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'passkey-item';
      const description = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = item.name || '通行密钥';
      const detail = document.createElement('small');
      const created = Number(item.createdAt) > 0
        ? formatter.format(new Date(Number(item.createdAt) * 1000))
        : '添加时间未知';
      const fingerprint = typeof item.id === 'string' ? item.id.slice(-8) : '';
      detail.textContent = `${created}${fingerprint ? ` · …${fingerprint}` : ''}`;
      description.append(title, detail);
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.textContent = '重命名';
      rename.addEventListener('click', () => openPasskeyActionDialog('rename', item));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '删除';
      remove.addEventListener('click', () => openPasskeyActionDialog('delete', item));
      const actions = document.createElement('span');
      actions.className = 'passkey-actions';
      actions.append(rename, remove);
      row.append(description, actions);
      passkeyList.append(row);
    }
  }

  async function refreshPasskeys() {
    passkeyList.innerHTML = '<p class="passkey-empty">正在读取通行密钥…</p>';
    try {
      const response = await fetch(`${basePath}/api/passkeys`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`passkey list ${response.status}`);
      const items = await response.json();
      if (!Array.isArray(items)) throw new Error('invalid passkey list');
      renderPasskeys(items);
    } catch {
      passkeyList.innerHTML = '<p class="passkey-empty">无法读取通行密钥</p>';
    }
  }

  async function refreshTotpStatus() {
    try {
      const response = await fetch(`${basePath}/api/totp/setup`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`totp status ${response.status}`);
      ({ enabled: totpEnabled } = await response.json());
      enableTotpButton.textContent = totpEnabled ? '移除' : '启用';
      enableTotpButton.classList.toggle('danger', totpEnabled);
      totpStatus.textContent = totpEnabled
        ? '已启用；密码登录需要六位动态验证码'
        : '为密码登录增加 TOTP 二次验证';
    } catch {
      totpStatus.textContent = '无法读取动态验证码状态';
    }
  }

  function drawTotpQr(matrix) {
    const quietZone = 4;
    const size = matrix.length + quietZone * 2;
    totpQr.width = size;
    totpQr.height = size;
    const context = totpQr.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, size, size);
    context.fillStyle = '#000';
    matrix.forEach((row, y) => {
      [...row].forEach((cell, x) => {
        if (cell === '1') context.fillRect(x + quietZone, y + quietZone, 1, 1);
      });
    });
  }

  function closeTotpDialog() {
    totpConfirmCode.value = '';
    totpSecretUri.value = '';
    totpSetupDialog.close();
    enableTotpButton.focus();
  }

  async function openTotpDialog() {
    totpConfirmCode.value = '';
    totpSecretUri.value = '';
    totpSecretPanel.hidden = true;
    totpSetupCopy.hidden = true;
    totpSetupConfirm.disabled = false;
    totpSetupTitle.textContent = totpEnabled ? '移除动态验证码' : '启用动态验证码';
    totpSetupDescription.textContent = totpEnabled
      ? '输入身份验证器当前显示的六位动态码，确认移除 TOTP。'
      : '正在生成仅用于本次设置的验证器密钥…';
    totpSetupConfirm.textContent = totpEnabled ? '确认移除' : '确认启用';
    totpSetupDialog.showModal();
    if (totpEnabled) {
      requestAnimationFrame(() => totpConfirmCode.focus());
      return;
    }
    totpSetupConfirm.disabled = true;
    try {
      const response = await fetch(`${basePath}/api/totp/setup`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Lumen-Action': 'totp-setup' },
      });
      if (!response.ok) throw new Error(`setup ${response.status}`);
      const result = await response.json();
      if (result.alreadyEnabled) {
        totpEnabled = true;
        closeTotpDialog();
        await refreshTotpStatus();
        showToast('动态验证码已经启用');
        return;
      }
      if (!result.uri || !Array.isArray(result.matrix)) throw new Error('invalid setup response');
      totpSecretUri.value = result.uri;
      drawTotpQr(result.matrix);
      totpSecretPanel.hidden = false;
      totpSetupCopy.hidden = false;
      totpSetupConfirm.disabled = false;
      totpSetupDescription.textContent = '扫描二维码后，输入身份验证器显示的六位动态码以完成启用。';
      totpConfirmCode.focus();
    } catch {
      closeTotpDialog();
      showToast('无法开始动态验证码设置');
    }
  }

  function setMobileCtrl(active) {
    mobileCtrl = active;
    mobileKeys.querySelector('[data-modifier="ctrl"]')?.classList.toggle('is-active', active);
  }

  addButton.addEventListener('click', addDefaultSession);
  tabStrip.addEventListener('contextmenu', event => {
    if (event.target.closest('.terminal-tab')) return;
    showContextMenu(event, stripContextItems(), () => sessions.get(activeId)?.term.focus());
  });
  settingsButton.addEventListener('click', openSettings);
  tabSessionPopover.addEventListener('pointerenter', () => {
    cancelHideHoverPopover(tabSessionPopover);
  });
  tabSessionPopover.addEventListener('pointerleave', () => {
    hideHoverPopover(tabSessionPopover);
  });
  for (const tab of settingsTabs) {
    tab.addEventListener('click', () => activateSettingsTab(tab.dataset.settingsTab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = settingsTabs.indexOf(tab);
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? settingsTabs.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + settingsTabs.length)
            % settingsTabs.length;
      settingsTabs[next].focus();
      activateSettingsTab(settingsTabs[next].dataset.settingsTab);
    });
  }
  registerPasskeyButton.addEventListener('click', async () => {
    if (!window.PublicKeyCredential) {
      showToast('当前浏览器不支持通行密钥');
      return;
    }
    registerPasskeyButton.disabled = true;
    try {
      const response = await fetch(`${basePath}/api/passkeys/register/options`, {
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`options ${response.status}`);
      const options = await response.json();
      options.challenge = decodeBase64Url(options.challenge);
      options.user.id = decodeBase64Url(options.user.id);
      const credential = await navigator.credentials.create({ publicKey: options });
      const result = await fetch(`${basePath}/api/passkeys/register`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Lumen-Action': 'passkey-register',
        },
        body: JSON.stringify({
          id: encodeBase64Url(credential.rawId),
          clientDataJSON: encodeBase64Url(credential.response.clientDataJSON),
          attestationObject: encodeBase64Url(credential.response.attestationObject),
        }),
      });
      if (!result.ok) throw new Error(`register ${result.status}`);
      showToast('通行密钥已添加');
      await refreshPasskeys();
    } catch (error) {
      if (error?.name !== 'NotAllowedError') showToast('添加通行密钥失败');
    } finally {
      registerPasskeyButton.disabled = false;
    }
  });
  passkeyActionCancel.addEventListener('click', closePasskeyActionDialog);
  passkeyActionConfirm.addEventListener('click', async () => {
    if (!pendingPasskeyAction) return;
    const { mode, item } = pendingPasskeyAction;
    const name = passkeyNameInput.value.trim();
    if (mode === 'rename' && !name) {
      showToast('通行密钥名称不能为空');
      passkeyNameInput.focus();
      return;
    }
    passkeyActionConfirm.disabled = true;
    try {
      const response = await fetch(`${basePath}/api/passkeys/${encodeURIComponent(item.id)}`, {
        method: mode === 'delete' ? 'DELETE' : 'PATCH',
        credentials: 'same-origin',
        headers: mode === 'delete'
          ? { 'X-Lumen-Action': 'passkey-delete' }
          : {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Lumen-Action': 'passkey-rename',
          },
        body: mode === 'delete' ? undefined : new URLSearchParams({ name }),
      });
      if (!response.ok) throw new Error(`passkey ${mode} ${response.status}`);
      closePasskeyActionDialog();
      await refreshPasskeys();
      showToast(mode === 'delete' ? '通行密钥已删除' : '通行密钥名称已更新');
    } catch {
      passkeyActionConfirm.disabled = false;
      showToast(mode === 'delete' ? '删除通行密钥失败' : '重命名通行密钥失败');
    }
  });
  passkeyNameInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      passkeyActionConfirm.click();
    }
  });
  enableTotpButton.addEventListener('click', openTotpDialog);
  totpSetupCancel.addEventListener('click', closeTotpDialog);
  totpSetupCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(totpSecretUri.value);
    } catch {
      totpSecretUri.select();
      document.execCommand('copy');
    }
    showToast('配置 URI 已复制');
  });
  totpSetupConfirm.addEventListener('click', async () => {
    const code = totpConfirmCode.value.trim();
    if (!/^\d{6}$/.test(code)) {
      showToast('请输入六位动态验证码');
      totpConfirmCode.focus();
      return;
    }
    totpSetupConfirm.disabled = true;
    try {
      const response = totpEnabled
        ? await fetch(`${basePath}/api/totp`, {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: {
            'X-Lumen-Action': 'totp-remove',
            'X-Lumen-Totp-Code': code,
          },
        })
        : await fetch(`${basePath}/api/totp/confirm`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Lumen-Action': 'totp-confirm',
          },
          body: new URLSearchParams({ code }),
        });
      if (!response.ok) throw new Error(`totp update ${response.status}`);
      const message = totpEnabled ? '动态验证码已移除' : '动态验证码已启用';
      closeTotpDialog();
      await refreshTotpStatus();
      showToast(message);
    } catch {
      totpSetupConfirm.disabled = false;
      totpConfirmCode.select();
      showToast('动态验证码不正确，请重试');
    }
  });
  themeButton.addEventListener('click', () => {
    const preference = followsSystemTheme ? 'system' : currentTheme;
    const next = { system: 'light', light: 'dark', dark: 'system' }[preference];
    setThemePreference(next, true);
  });
  focusButton.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', syncFullscreenState);
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
    pendingForceTerminate = false;
  });
  sessionDialog.addEventListener('close', () => {
    pendingForceTerminate = false;
    sessionDialog.classList.remove('is-protected-warning');
  });
  sessionDialog.addEventListener('click', event => {
    if (event.target === sessionDialog) closeSessionDialog();
  });
  settingsDialog.addEventListener('click', event => {
    if (event.target === settingsDialog) settingsDialog.close();
  });
  settingsDialog.addEventListener('close', () => {
    for (const control of document.querySelectorAll('.custom-select.is-open')) closeCustomSelect(control);
    applyCursorBlink();
    sessions.get(activeId)?.term.focus();
  });
  copySelectionSetting.addEventListener('change', () => {
    settings.copySelection = copySelectionSetting.checked;
    saveSettings();
  });
  fontSizeSetting.addEventListener('input', () => {
    applyFontSize(Number(fontSizeSetting.value));
    saveSettings();
  });
  fontWeightSetting.addEventListener('input', () => {
    settings.fontWeight = Number(fontWeightSetting.value);
    applyTerminalAppearance();
    saveSettings();
  });
  letterSpacingSetting.addEventListener('input', () => {
    settings.letterSpacing = Number(letterSpacingSetting.value);
    applyTerminalAppearance();
    saveSettings();
  });
  scrollbackSetting.addEventListener('input', () => {
    settings.scrollback = Number(scrollbackSetting.value);
    applyTerminalAppearance();
    saveSettings();
  });
  cursorBlinkSetting.addEventListener('change', () => {
    settings.cursorBlink = cursorBlinkSetting.checked;
    applyTerminalAppearance();
    saveSettings();
    showToast(settings.cursorBlink ? '光标闪烁已启用，返回终端后可见' : '光标闪烁已关闭');
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
  inheritWorkingDirectorySetting.addEventListener('change', () => {
    settings.inheritWorkingDirectory = inheritWorkingDirectorySetting.checked;
    saveSettings();
  });
  persistTerminalStateSetting.addEventListener('change', () => {
    settings.persistTerminalState = persistTerminalStateSetting.checked;
    if (!settings.persistTerminalState) void globalThis.LumenTerminalState.clear();
    saveSettings();
  });
  installCustomSelect(rootMaxSessionsSetting, value => {
    settings.rootMaxSessions = Math.max(1, Math.min(8, Number(value) || 2));
    privilegedPolicy.maxSessions = settings.rootMaxSessions;
    for (const session of sessions.values()) session.privilegedMethods = null;
    saveSettings();
  });
  defaultRootSessionSetting.addEventListener('change', () => {
    settings.defaultRootSession = defaultRootSessionSetting.checked;
    saveSettings();
  });
  rootRequireVerificationSetting.addEventListener('change', () => {
    settings.rootRequireVerification = rootRequireVerificationSetting.checked;
    privilegedPolicy.requireVerification = settings.rootRequireVerification;
    for (const session of sessions.values()) session.privilegedMethods = null;
    saveSettings();
    showToast(settings.rootRequireVerification
      ? 'root 会话二次验证已启用'
      : 'root 会话二次验证已关闭，请谨慎使用');
  });
  captureShortcut(shortcutSearchSetting, 'search');
  captureShortcut(shortcutNewTabSetting, 'newTab');
  installCustomSelect(cursorStyleSetting, value => {
    settings.cursorStyle = value;
    applyTerminalAppearance();
    saveSettings();
  });
  installCustomSelect(fontFamilySetting, value => {
    settings.fontFamily = value;
    applyTerminalAppearance();
    saveSettings();
  });
  installCustomSelect(themeSetting, value => setThemePreference(value, true));
  installCustomSelect(sessionManagerSort, value => {
    sessionSort = value;
    renderSessionManager();
  });
  installCustomSelect(sessionStatusFilter, value => {
    sessionStatus = value;
    renderSessionManager();
  });
  installCustomSelect(idleCleanupThreshold, value => {
    settings.idleCleanupSeconds = Number(value);
    saveSettings();
    renderIdleCleanupPreview();
  });
  installCustomSelect(diagnosticsSourceFilter, value => {
    diagnosticsSource = value;
    renderDiagnostics();
  });
  installCustomSelect(auditEventFilter, value => {
    auditEventCategory = value;
    renderAuditLog();
  });
  installCustomSelect(auditTimeFilter, value => {
    auditTimeRange = value;
    renderAuditLog();
  });
  exportTerminalButton.addEventListener('click', () => exportCurrentTerminal());
  logoutToggleButton.addEventListener('click', () => {
    hideContextMenu();
    logoutSessionButton.disabled = false;
    logoutSessionButton.textContent = '确认退出';
    logoutDialog.showModal();
    requestAnimationFrame(() => logoutCancelButton.focus());
  });
  logoutCancelButton.addEventListener('click', () => logoutDialog.close());
  logoutSessionButton.addEventListener('click', async () => {
    logoutSessionButton.disabled = true;
    logoutSessionButton.textContent = '正在退出…';
    try {
      authChannel?.postMessage({ type: 'logout' });
      for (const session of sessions.values()) {
        if (session.socket?.readyState < WebSocket.CLOSING) session.socket.close(1000, 'logout');
      }
      const response = await fetch(`${basePath}/auth/logout`, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'manual',
        headers: { 'X-Lumen-Action': 'logout' },
      });
      if (response.status !== 0 && response.status !== 303 && !response.ok) {
        throw new Error(`logout returned ${response.status}`);
      }
      await globalThis.LumenTerminalState.clear();
      window.location.assign(`${basePath}/login`);
    } catch (error) {
      console.error('[lumen] logout failed', error);
      logoutSessionButton.disabled = false;
      logoutSessionButton.textContent = '确认退出';
      showToast('退出登录失败，请稍后重试');
    }
  });
  authChannel?.addEventListener('message', event => {
    if (event.data?.type !== 'logout') return;
    for (const session of sessions.values()) {
      session.destroyed = true;
      clearTimeout(session.reconnectTimer);
      if (session.socket?.readyState < WebSocket.CLOSING) session.socket.close(1000, 'logout');
    }
    window.location.assign(`${basePath}/login`);
  });
  refreshSessionManagerButton.addEventListener('click', loadSessionManager);
  cleanupIdleSessionsButton.addEventListener('click', openIdleCleanup);
  idleCleanupCancel.addEventListener('click', () => {
    pendingCleanupCandidates = null;
    idleCleanupDialog.close();
  });
  idleCleanupConfirm.addEventListener('click', () => void cleanupIdleSessions());
  document.getElementById('select-visible-sessions').addEventListener('click', () => {
    const visibleIds = [...sessionManagerList.querySelectorAll('[data-session-id]')]
      .map(row => row.dataset.sessionId);
    const allSelected = visibleIds.length && visibleIds.every(id => selectedSessionIds.has(id));
    for (const id of visibleIds) {
      if (allSelected) selectedSessionIds.delete(id);
      else selectedSessionIds.add(id);
    }
    renderSessionManager();
  });
  document.getElementById('protect-selected-sessions').addEventListener('click',
    () => void setSelectedSessionsProtected(true));
  document.getElementById('unprotect-selected-sessions').addEventListener('click',
    () => void setSelectedSessionsProtected(false));
  document.getElementById('terminate-selected-sessions').addEventListener('click', () => {
    const candidates = sessionInventory.filter(item =>
      selectedSessionIds.has(item.id) && Number(item.clients) === 0 && !item.protected);
    openIdleCleanup(candidates);
  });
  document.getElementById('clear-diagnostics').addEventListener('click', () => {
    globalThis.LumenDiagnostics.clear();
    showToast('前端错误记录已清空');
  });
  document.getElementById('copy-diagnostics').addEventListener('click', () => {
    const copied = copyWithSelection(diagnosticsJson());
    showToast(copied ? '诊断记录已复制' : '无法复制诊断记录');
  });
  document.getElementById('export-diagnostics').addEventListener('click', exportDiagnostics);
  document.getElementById('refresh-service-health').addEventListener('click',
    () => void refreshServiceHealth());
  refreshDependenciesButton.addEventListener('click', () => {
    dependencySummary.textContent = '正在重新检查…';
    void refreshServiceHealth(false);
  });
  document.getElementById('copy-service-diagnostics').addEventListener('click', copyServiceDiagnostics);
  globalThis.LumenDiagnostics.subscribe(() => {
    if (activeSettingsTab === 'diagnostics' && settingsDialog.open) renderDiagnostics();
  });
  refreshAuditLogButton.addEventListener('click', () => void refreshAuditLog());
  auditLogSearch.addEventListener('input', renderAuditLog);
  document.getElementById('export-audit-json').addEventListener('click', () => exportAuditLog('json'));
  document.getElementById('export-audit-csv').addEventListener('click', () => exportAuditLog('csv'));
  sessionManagerSearch.addEventListener('input', renderSessionManager);
  document.getElementById('add-command-snippet').addEventListener('click', () => openSnippetEditor());
  document.getElementById('cancel-command-snippet').addEventListener('click', closeSnippetEditor);
  document.getElementById('save-command-snippet').addEventListener('click', saveCommandSnippet);
  connectionDisconnectConfirm.addEventListener('click', disconnectManagedConnection);
  connectionDisconnectCancel.addEventListener('click', () => {
    pendingConnection = null;
    connectionDialog.close();
  });
  connectionDialog.addEventListener('close', () => {
    pendingConnection = null;
  });
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
    const primary = sessions.get(splitLayout.primaryId);
    if (primary && primary !== session) scheduleResize(primary);
    const secondary = sessions.get(splitLayout.secondaryId);
    if (secondary) scheduleResize(secondary);
  });
  resizeObserver.observe(stage);

  splitDivider.addEventListener('pointerdown', event => {
    event.preventDefault();
    splitDivider.setPointerCapture(event.pointerId);
    stage.classList.add('is-resizing-split');
  });
  splitDivider.addEventListener('pointermove', event => {
    if (!splitDivider.hasPointerCapture(event.pointerId)) return;
    const bounds = stage.getBoundingClientRect();
    const raw = splitLayout.direction === 'horizontal'
      ? (event.clientY - bounds.top) / bounds.height
      : (event.clientX - bounds.left) / bounds.width;
    splitLayout.resize(raw);
    stage.style.setProperty('--split-ratio', `${splitLayout.ratio * 100}%`);
    splitDivider.setAttribute('aria-valuenow', String(Math.round(splitLayout.ratio * 100)));
    const primary = sessions.get(splitLayout.primaryId);
    const secondary = sessions.get(splitLayout.secondaryId);
    if (primary) scheduleResize(primary);
    if (secondary) scheduleResize(secondary);
  });
  const stopSplitResize = event => {
    if (splitDivider.hasPointerCapture(event.pointerId)) {
      splitDivider.releasePointerCapture(event.pointerId);
    }
    stage.classList.remove('is-resizing-split');
  };
  splitDivider.addEventListener('pointerup', stopSplitResize);
  splitDivider.addEventListener('pointercancel', stopSplitResize);
  splitDivider.addEventListener('keydown', event => {
    const backward = splitLayout.direction === 'horizontal' ? 'ArrowUp' : 'ArrowLeft';
    const forward = splitLayout.direction === 'horizontal' ? 'ArrowDown' : 'ArrowRight';
    if (![backward, forward, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0.25
      : event.key === 'End' ? 0.75
        : splitLayout.ratio + (event.key === forward ? 0.05 : -0.05);
    splitLayout.resize(next);
    stage.style.setProperty('--split-ratio', `${splitLayout.ratio * 100}%`);
    splitDivider.setAttribute('aria-valuenow', String(Math.round(splitLayout.ratio * 100)));
    scheduleResize(sessions.get(splitLayout.primaryId));
    scheduleResize(sessions.get(splitLayout.secondaryId));
    saveState();
  });

  window.addEventListener('keydown', event => {
    if (event.ctrlKey && event.shiftKey && event.code === 'Enter') {
      event.preventDefault();
      void toggleFullscreen();
      return;
    }
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
      addDefaultSession();
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

  const pingPoller = new AdaptivePoller(() => {
    const now = performance.now();
    for (const session of sessions.values()) pingSession(session, now);
  }, () => document.hidden ? 2000 : 500);
  pingPoller.start(500);

  const inventoryPoller = new AdaptivePoller(async () => {
    if (!document.hidden) await refreshSessionInventory();
  }, () => document.hidden
    ? 30000
    : activeSettingsTab === 'sessions' && settingsDialog.open ? 4000 : 15000);
  inventoryPoller.start(4000);
  const auditPoller = new AdaptivePoller(async () => {
    if (!document.hidden && activeSettingsTab === 'audit'
        && settingsDialog.open && auditAutoRefresh.checked) await refreshAuditLog();
  }, () => 10000);
  auditPoller.start(10000);
  const healthPoller = new AdaptivePoller(async () => {
    if (!document.hidden) await refreshServiceHealth(false);
  }, () => ['health', 'dependencies'].includes(activeSettingsTab) && settingsDialog.open
    ? HEALTH_REFRESH_INTERVAL
    : 30000);
  healthPoller.start(1500);

  systemThemeQuery.addEventListener?.('change', event => {
    if (followsSystemTheme) applyTheme(event.matches ? 'light' : 'dark', false);
  });

  applyTheme(currentTheme, false);
  void globalThis.LumenTerminalState.purgeOlderThan(Date.now() - 24 * 60 * 60 * 1000);
  async function initializeSessions() {
    await syncPreferences();
    const restored = loadState();
    const initialInventory = await refreshSessionInventory();
    if (initialInventory) {
      const byId = new Map(initialInventory.map(item => [item.id, item]));
      for (const tab of restored.tabs) {
        const item = byId.get(tab.id);
        if (item) {
          tab.privileged = item.privileged === true;
          if (tab.privileged) tab.privilegedMode = 'connect';
        } else if (tab.privileged) {
          tab.privilegedMode = 'create';
        }
      }
    }
    restored.tabs.forEach(tab => createSession(tab, false));
    if (restored.split) splitLayout.restore(restored.split, new Set(sessions.keys()));
    activateSession(restored.activeId);
  }
  void initializeSessions();
})();
