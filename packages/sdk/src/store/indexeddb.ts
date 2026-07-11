/**
 * IndexedDBStore — the default browser-local ChatStore.
 *
 * One database ("wepi"), one object store ("chats"), keyed by chat id. Nothing
 * touches IndexedDB until a method is called, so importing this module is safe
 * anywhere (including SSR).
 */

import type { ChatSnapshot, ChatStore } from "./index.js";

const DB_NAME = "wepi";
const STORE = "chats";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export class IndexedDBStore implements ChatStore {
  async load(id: string): Promise<ChatSnapshot | null> {
    const got = await tx<ChatSnapshot | undefined>("readonly", (s) => s.get(id) as IDBRequest<ChatSnapshot | undefined>);
    return got ?? null;
  }

  async save(id: string, snapshot: ChatSnapshot): Promise<void> {
    await tx("readwrite", (s) => s.put(snapshot, id));
  }

  async list(): Promise<{ id: string; updatedAt: number }[]> {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const out: { id: string; updatedAt: number }[] = [];
        const req = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return resolve(out);
          out.push({ id: String(cursor.key), updatedAt: (cursor.value as ChatSnapshot).updatedAt });
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  async delete(id: string): Promise<void> {
    await tx("readwrite", (s) => s.delete(id));
  }
}
