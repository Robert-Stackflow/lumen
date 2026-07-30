(function exposeSessionManager(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LumenSessionManager = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function formatDateTime(timestamp, locale = 'zh-CN') {
    if (!timestamp || !Number.isFinite(timestamp)) return '未知';
    return new Intl.DateTimeFormat(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(timestamp));
  }

  function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return '未知';
    const seconds = Math.floor(milliseconds / 1000);
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`;
    return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
  }

  function isCurrentConnection(session, connection) {
    return Boolean(session?.connectionKey
      && connection?.browserKey
      && session.connectionKey === connection.browserKey);
  }

  return { formatDateTime, formatDuration, isCurrentConnection };
}));
