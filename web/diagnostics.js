(function (global) {
  'use strict';
  const STORAGE_KEY = 'lumen.diagnostics.v1';
  const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
  function load() {
    try {
      const stored = JSON.parse(global.localStorage?.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(stored)
        ? stored.filter(entry => entry && Date.now() - Number(entry.timestamp) < MAX_AGE)
          .slice(0, 100) : [];
    } catch { return []; }
  }
  const entries = load();
  const listeners = new Set();
  function persist() {
    try { global.localStorage?.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* storage unavailable */ }
  }
  function report(source, error) {
    const message = String(error?.message || error || '未知异常').slice(0, 500);
    const previous = entries[0];
    if (previous && previous.source === source && previous.message === message) {
      previous.count += 1; previous.timestamp = Date.now();
    } else {
      entries.unshift({ source, message, timestamp: Date.now(), count: 1 });
      if (entries.length > 100) entries.length = 100;
    }
    persist();
    listeners.forEach(listener => listener(list()));
  }
  function list() { return entries.map(entry => ({ ...entry })); }
  function clear() {
    entries.length = 0;
    try { global.localStorage?.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
    listeners.forEach(listener => listener([]));
  }
  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  function category(entry) {
    const source = String(entry?.source || '').toLocaleLowerCase();
    if (source.includes('websocket')) return 'websocket';
    if (source.includes('indexeddb')) return 'indexeddb';
    if (source.includes('偏好')) return 'preferences';
    if (source.includes('javascript') || source.includes('promise')) return 'javascript';
    return 'other';
  }
  function filter(source) {
    const snapshot = list();
    return source === 'all' ? snapshot : snapshot.filter(entry => category(entry) === source);
  }
  function serialize(source = 'all') { return JSON.stringify(filter(source), null, 2); }
  global.addEventListener('error', event => report('JavaScript', event.error || event.message));
  global.addEventListener('unhandledrejection', event => report('Promise', event.reason));
  global.LumenDiagnostics = Object.freeze({
    report, list, clear, subscribe, category, filter, serialize,
  });
})(globalThis);
