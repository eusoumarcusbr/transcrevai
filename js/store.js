// store.js: histórico local (IndexedDB), só neste navegador.

const DB = 'transcrevai';
const STORE = 'docs';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => { db.close(); resolve(result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export async function saveDoc(doc) {
  try {
    // guarda sem o áudio (pesado demais)
    const { media, ...rest } = doc;
    await tx('readwrite', (s) => s.put(JSON.parse(JSON.stringify(rest))));
  } catch (e) {
    console.warn('não salvou no histórico', e);
  }
}

export async function listDocs() {
  try {
    const all = await tx('readonly', (s) => reqP(s.getAll()));
    return (all || [])
      .map((d) => ({ id: d.id, title: d.title, createdAt: d.createdAt, duration: d.duration, diarized: d.diarized, speakers: d.speakers }))
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function getDoc(id) {
  try { return await tx('readonly', (s) => reqP(s.get(id))); } catch { return null; }
}

export async function deleteDoc(id) {
  try { await tx('readwrite', (s) => s.delete(id)); } catch { /* ok */ }
}
