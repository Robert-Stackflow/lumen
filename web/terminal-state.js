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
  };
  root.LumenTerminalState = api;
}(globalThis));
