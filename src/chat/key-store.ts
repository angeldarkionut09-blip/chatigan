import type { ChatIdentity } from "./crypto.js";

type StoredIdentity = ChatIdentity & { userId: string };
type StoredTrust = { id: string; fingerprint: string; confirmedAt: string };

const DATABASE_NAME = "chatigan-local-chat-keys";
const DATABASE_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("identities")) database.createObjectStore("identities", { keyPath: "userId" });
      if (!database.objectStoreNames.contains("trust")) database.createObjectStore("trust", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Stocarea locală a cheilor nu este disponibilă."));
    request.onblocked = () => reject(new Error("Închide celelalte file ChaTiganu și reîncarcă pagina."));
  });
}

async function requestValue<T>(storeName: string, mode: IDBTransactionMode, requestFactory: (store: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = requestFactory(transaction.objectStore(storeName));
    let value: T | undefined;
    request.onsuccess = () => { value = request.result as T | undefined; };
    request.onerror = () => reject(request.error ?? new Error("Stocarea locală nu a putut fi citită."));
    transaction.oncomplete = () => { database.close(); resolve(value); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("Stocarea locală nu a putut fi actualizată.")); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("Operațiunea locală a fost anulată.")); };
  });
}

export async function loadIdentity(userId: string): Promise<ChatIdentity | undefined> {
  const value = await requestValue<StoredIdentity>("identities", "readonly", (store) => store.get(userId));
  if (!value || value.userId !== userId) return undefined;
  return value;
}

export async function saveIdentity(userId: string, identity: ChatIdentity): Promise<void> {
  await requestValue<IDBValidKey>("identities", "readwrite", (store) => store.put({ ...identity, userId } satisfies StoredIdentity));
}

export async function loadTrust(contactId: string): Promise<StoredTrust | undefined> {
  return requestValue<StoredTrust>("trust", "readonly", (store) => store.get(contactId));
}

export async function saveTrust(contactId: string, fingerprint: string): Promise<void> {
  await requestValue<IDBValidKey>("trust", "readwrite", (store) => store.put({ id: contactId, fingerprint, confirmedAt: new Date().toISOString() } satisfies StoredTrust));
}
