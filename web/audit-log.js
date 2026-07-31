(function exposeAuditLog(root) {
  const EVENT_LABELS = {
    login_success: '登录成功',
    login_failed: '登录失败',
    login_locked: '登录受限',
    logout: '退出登录',
    ws_connected: '终端已连接',
    ws_disconnected: '终端已断开',
    session_terminated: '终止会话',
    session_protected: '保护会话',
    session_unprotected: '取消保护会话',
    connection_disconnected: '断开连接',
    passkey_registered: '添加通行密钥',
    passkey_deleted: '删除通行密钥',
    passkey_renamed: '重命名通行密钥',
    totp_setup_started: '开始配置动态验证码',
    totp_enabled: '启用动态验证码',
    totp_removed: '移除动态验证码',
    preferences_updated: '更新设置',
  };
  const CATEGORIES = {
    auth: ['login_success', 'login_failed', 'login_locked', 'logout', 'passkey_registered',
      'passkey_deleted', 'passkey_renamed', 'totp_setup_started', 'totp_enabled', 'totp_removed'],
    terminal: ['ws_connected', 'ws_disconnected', 'session_protected', 'session_unprotected'],
    danger: ['login_failed', 'login_locked', 'session_terminated', 'connection_disconnected',
      'passkey_deleted', 'totp_removed'],
    settings: ['preferences_updated'],
  };
  const RANGES = { hour: 3600000, day: 86400000, week: 604800000 };

  function filter(entries, { query = '', category = 'all', range = 'all', now = Date.now() } = {}) {
    const needle = query.trim().toLocaleLowerCase();
    const cutoff = RANGES[range] ? now - RANGES[range] : 0;
    return entries.filter(entry => {
      const time = Date.parse(entry.timestamp);
      return (category === 'all' || CATEGORIES[category]?.includes(entry.event))
        && (!cutoff || Number.isFinite(time) && time >= cutoff)
        && `${entry.event} ${entry.client} ${entry.detail} ${EVENT_LABELS[entry.event] || ''}`
          .toLocaleLowerCase().includes(needle);
    });
  }

  function serialize(entries, format) {
    const rows = entries.map(({ timestamp, event, client, detail }) =>
      ({ timestamp, event, client, detail }));
    if (format !== 'csv') return JSON.stringify(rows, null, 2);
    const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    return ['timestamp,event,client,detail',
      ...rows.map(row => [row.timestamp, row.event, row.client, row.detail].map(cell).join(','))]
      .join('\n');
  }

  root.LumenAuditLog = { EVENT_LABELS, filter, serialize };
}(globalThis));
