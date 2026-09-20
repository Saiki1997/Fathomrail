/** Optional File System Access directory — used when the browser allows a real save folder. */

const IDB_NAME = "fathomrail-fs";
const IDB_KEY = "download-dir";

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode?: "read" | "readwrite" }) => Promise<"granted" | "denied" | "prompt">;
  requestPermission?: (d: { mode?: "read" | "readwrite" }) => Promise<"granted" | "denied" | "prompt">;
};

let memoryHandle: DirHandle | null = null;

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function restoreDirectoryHandle(): Promise<DirHandle | null> {
  if (memoryHandle) return memoryHandle;
  try {
    const db = await idb();
    const handle = await new Promise<DirHandle | null>((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const r = tx.objectStore("kv").get(IDB_KEY);
      r.onsuccess = () => resolve((r.result as DirHandle | undefined) ?? null);
      r.onerror = () => reject(r.error);
    });
    if (!handle) return null;
    const perm = handle.queryPermission ? await handle.queryPermission({ mode: "readwrite" }) : "granted";
    if (perm === "granted") {
      memoryHandle = handle;
      return handle;
    }
    if (perm === "prompt" && handle.requestPermission) {
      const next = await handle.requestPermission({ mode: "readwrite" });
      if (next === "granted") {
        memoryHandle = handle;
        return handle;
      }
    }
  } catch {
    /* unsupported */
  }
  return null;
}

export async function pickDownloadFolder(): Promise<DirHandle | null> {
  const picker = (window as Window & { showDirectoryPicker?: () => Promise<DirHandle> }).showDirectoryPicker;
  if (!picker) return null;
  const handle = await picker();
  memoryHandle = handle;
  try {
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(handle, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore persist failure */
  }
  return handle;
}

export function currentFolderLabel(fallback: string): string {
  return memoryHandle?.name ?? fallback;
}

export function hasDirectoryHandle(): boolean {
  return memoryHandle != null;
}

export async function writeRelativeFile(relativePath: string, data: Blob): Promise<void> {
  if (!memoryHandle) throw new Error("No download folder selected");
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error("Bad path");
  let dir: FileSystemDirectoryHandle = memoryHandle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const file = await dir.getFileHandle(fileName, { create: true });
  const w = await file.createWritable();
  await w.write(data);
  await w.close();
}
