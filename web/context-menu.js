(function (global) {
  'use strict';
  const icons = {
    activate: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    rename: '<path d="m4 16-.5 4 4-.5L18 9l-3-3L4 16Zm9-8 3 3"/>',
    pin: '<path d="M9 4h6M10 4v5l-3 3h10l-3-3V4M12 12v9"/>',
    unpin: '<path d="M10 4h5m-5 0v3m5-3v5l2 3h-5M12 12v3M4 4l16 16"/>',
    readonly: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    writable: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M9 10V7a4 4 0 0 1 7.7-1.5"/>',
    split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
    unsplit: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 8l8 8m0-8-8 8"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    paste: '<path d="M9 5h6M9 3h6v4H9z"/><path d="M7 5H5v16h14V5h-2"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
    select: '<path d="M7 3H3v4M17 3h4v4M7 21H3v-4M17 21h4v-4"/><path d="M8 9h8M8 13h8M8 17h5"/>',
    export: '<path d="M12 3v12m-4-4 4 4 4-4"/><path d="M5 19h14"/>',
    clear: '<path d="m4 15 8-11 8 11-5 5H9l-5-5Z"/><path d="m8 14 5 5"/>',
    add: '<path d="M12 5v14M5 12h14"/>', settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12h2M3 12h2M12 3v2m0 14v2M17 7l1.5-1.5M5.5 18.5 7 17m10 0 1.5 1.5M5.5 5.5 7 7"/>',
    sessions: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    close: '<path d="m7 7 10 10M17 7 7 17"/>', terminate: '<path d="M12 3v9"/><path d="M6.3 5.8a8 8 0 1 0 11.4 0"/>',
  };
  function show(menu, event, items, onSelect) {
    menu.replaceChildren();
    for (const item of items) {
      if (item.separator) {
        const separator = document.createElement('div');
        separator.className = 'context-menu-separator';
        separator.setAttribute('role', 'separator');
        menu.append(separator);
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
      icon.innerHTML = icons[item.icon] || '';
      const label = document.createElement('span');
      label.textContent = item.label;
      const shortcut = document.createElement('kbd');
      shortcut.textContent = item.shortcut || '';
      button.append(icon, label, shortcut);
      button.addEventListener('click', () => onSelect(item));
      menu.append(button);
    }
    menu.hidden = false;
    menu.style.left = '0';
    menu.style.top = '0';
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(event.clientX, innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(event.clientY, innerHeight - rect.height - margin));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.transformOrigin =
      `${event.clientX < left + rect.width / 2 ? 'left' : 'right'} `
      + `${event.clientY < top + rect.height / 2 ? 'top' : 'bottom'}`;
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  global.LumenContextMenu = Object.freeze({ icons, show });
})(globalThis);
