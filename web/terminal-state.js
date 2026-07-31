(function exposeTerminalState(root) {
  const DB_NAME = 'lumen-terminal-state';
  const STORE = 'snapshots';

  function database() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function transact(mode, action) {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = action(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  const api = {
    load: id => transact('readonly', store => store.get(id)),
    save: (id, snapshot) => transact('readwrite', store => store.put(snapshot, id)),
    remove: id => transact('readwrite', store => store.delete(id)),
    clear: async () => {
      const db = await database();
      try {
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE, 'readwrite');
          const request = transaction.objectStore(STORE).clear();
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      } finally {
        db.close();
      }
    },
    purgeOlderThan: async cutoff => {
      const db = await database();
      try {
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE, 'readwrite');
          const request = transaction.objectStore(STORE).openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (!cursor.value?.savedAt || cursor.value.savedAt < cutoff) cursor.delete();
            cursor.continue();
          };
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      } finally {
        db.close();
      }
    },
  };
  root.LumenTerminalState = api;
}(globalThis));
