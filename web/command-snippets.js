(function exposeCommandSnippets(root) {
  function normalize(item) {
    if (!item || typeof item.command !== 'string') return null;
    return {
      id: typeof item.id === 'string' ? item.id.slice(0, 64) : crypto.randomUUID(),
      name: typeof item.name === 'string' && item.name.trim()
        ? item.name.trim().slice(0, 40) : '未命名片段',
      command: item.command.slice(0, 2000),
      run: Boolean(item.run),
    };
  }

  function upsert(items, item) {
    const normalized = normalize(item);
    if (!normalized) return items;
    const next = [...items];
    const index = next.findIndex(candidate => candidate.id === normalized.id);
    if (index >= 0) next[index] = normalized;
    else next.push(normalized);
    return next.slice(0, 40);
  }

  function isDangerous(command) {
    return /(^|[;&|]\s*)(rm\s+-[a-z]*r[a-z]*|mkfs|shutdown|reboot|poweroff|dd\s+if=|git\s+reset\s+--hard)\b/i
      .test(command);
  }

  root.LumenCommandSnippets = { isDangerous, normalize, upsert };
}(globalThis));
