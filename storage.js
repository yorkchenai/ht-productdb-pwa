const DATABASE_NAME = "htgroups-product-pwa";
const DATABASE_VERSION = 1;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本地资料读取失败"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("本地资料保存失败"));
    transaction.onabort = () => reject(transaction.error || new Error("本地资料保存已取消"));
  });
}

let databasePromise;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("state")) database.createObjectStore("state");
      if (!database.objectStoreNames.contains("snapshots")) database.createObjectStore("snapshots", { keyPath: "id" });
      if (!database.objectStoreNames.contains("images")) {
        const images = database.createObjectStore("images", { keyPath: "key" });
        images.createIndex("snapshotId", "snapshotId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开手机本地资料库"));
  });
  return databasePromise;
}

async function readState(key) {
  const database = await openDatabase();
  const transaction = database.transaction("state", "readonly");
  return requestResult(transaction.objectStore("state").get(key));
}

export async function getCurrentSnapshot() {
  const snapshotId = await readState("currentSnapshotId");
  if (!snapshotId) return null;
  const database = await openDatabase();
  const transaction = database.transaction("snapshots", "readonly");
  return requestResult(transaction.objectStore("snapshots").get(snapshotId));
}

export async function hasPreviousSnapshot() {
  return Boolean(await readState("previousSnapshotId"));
}

async function deleteImagesForSnapshot(store, snapshotId) {
  if (!snapshotId) return;
  const index = store.index("snapshotId");
  const request = index.openKeyCursor(IDBKeyRange.only(snapshotId));
  await new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

export async function saveSnapshot(snapshot, images) {
  const database = await openDatabase();
  const transaction = database.transaction(["state", "snapshots", "images"], "readwrite", { durability: "strict" });
  const state = transaction.objectStore("state");
  const snapshots = transaction.objectStore("snapshots");
  const imageStore = transaction.objectStore("images");
  const currentId = await requestResult(state.get("currentSnapshotId"));
  const previousId = await requestResult(state.get("previousSnapshotId"));

  if (previousId) {
    snapshots.delete(previousId);
    await deleteImagesForSnapshot(imageStore, previousId);
  }

  snapshots.put(snapshot);
  for (const image of images) {
    imageStore.put({
      key: `${snapshot.id}:${image.name}`,
      snapshotId: snapshot.id,
      name: image.name,
      blob: image.blob
    });
  }
  if (currentId) state.put(currentId, "previousSnapshotId");
  else state.delete("previousSnapshotId");
  state.put(snapshot.id, "currentSnapshotId");
  await transactionDone(transaction);
}

export async function restorePreviousSnapshot() {
  const database = await openDatabase();
  const transaction = database.transaction("state", "readwrite", { durability: "strict" });
  const store = transaction.objectStore("state");
  const currentId = await requestResult(store.get("currentSnapshotId"));
  const previousId = await requestResult(store.get("previousSnapshotId"));
  if (!previousId) throw new Error("没有可恢复的上一版资料");
  store.put(previousId, "currentSnapshotId");
  if (currentId) store.put(currentId, "previousSnapshotId");
  await transactionDone(transaction);
  return getCurrentSnapshot();
}

export async function getCurrentImage(name) {
  if (!name) return null;
  const snapshotId = await readState("currentSnapshotId");
  if (!snapshotId) return null;
  const database = await openDatabase();
  const transaction = database.transaction("images", "readonly");
  const result = await requestResult(transaction.objectStore("images").get(`${snapshotId}:${name}`));
  return result?.blob || null;
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try { return await navigator.storage.persist(); } catch { return false; }
}
