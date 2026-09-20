import { getCurrentSessionUser } from './authStore';
import { identifySourceDocument, SourceDocumentRef } from '../utils/evidenceProvenance';

const DB_NAME = 'LawFlow_Source_Documents_v1';
const STORE_NAME = 'documents';

interface StoredSourceDocument {
  id: string;
  caseId: string;
  documentId?: string;
  contentHash?: string;
  fileName: string;
  file: File;
  savedAt: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveSourceDocument(caseId: string, file: File, identified?: SourceDocumentRef): Promise<SourceDocumentRef> {
  const source = identified || await identifySourceDocument(file);
  const userId = getCurrentSessionUser()?.id || 'DEFAULT_USER';
  const db = await openDb();
  const transaction = db.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).put({
    id: storageId(userId, caseId, source.documentId),
    caseId,
    documentId: source.documentId,
    contentHash: source.contentHash,
    fileName: file.name,
    file,
    savedAt: new Date().toISOString()
  } satisfies StoredSourceDocument);
  await transactionDone(transaction);
  db.close();
  return source;
}

export async function getSourceDocument(caseId: string, fileName: string, sourceDocumentId?: string): Promise<File | null> {
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const userId = getCurrentSessionUser()?.id || 'DEFAULT_USER';
    const store = transaction.objectStore(STORE_NAME);
    let record: StoredSourceDocument | undefined;
    if (sourceDocumentId) {
      const request = store.get(storageId(userId, caseId, sourceDocumentId));
      record = await requestResult<StoredSourceDocument | undefined>(request);
    }
    // Legacy records were keyed only by file name. Keep them readable while
    // newly imported evidence uses its content-derived document identity.
    if (!record) record = await findStoredDocument(store, userId, caseId, fileName, sourceDocumentId);
    db.close();
    return record?.file || null;
  } catch {
    return null;
  }
}

export async function deleteSourceDocument(caseId: string, fileName: string, sourceDocumentId?: string): Promise<void> {
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const userId = getCurrentSessionUser()?.id || 'DEFAULT_USER';
    const store = transaction.objectStore(STORE_NAME);
    if (sourceDocumentId) store.delete(storageId(userId, caseId, sourceDocumentId));
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value as StoredSourceDocument;
      const matchesSource = sourceDocumentId
        ? record.documentId === sourceDocumentId
        : record.fileName === fileName;
      if (record.caseId === caseId && record.id.startsWith(`${userId}|`) && matchesSource) cursor.delete();
      cursor.continue();
    };
    await transactionDone(transaction);
    db.close();
  } catch {
    // Removing an account must not be blocked by optional local document cleanup.
  }
}

export async function deleteSourceDocumentsForCase(caseId: string): Promise<void> {
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const userId = getCurrentSessionUser()?.id || 'DEFAULT_USER';
    const done = transactionDone(transaction);
    const request = store.openCursor();
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const record = cursor.value as StoredSourceDocument;
        if (record.caseId === caseId && record.id.startsWith(`${userId}|`)) {
          cursor.delete();
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    await done;
    db.close();
  } catch {
    // Case deletion should still succeed when optional source storage is unavailable.
  }
}

function storageId(userId: string, caseId: string, documentId: string): string {
  return `${userId}|${caseId}|${documentId}`;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function findStoredDocument(
  store: IDBObjectStore,
  userId: string,
  caseId: string,
  fileName: string,
  sourceDocumentId?: string
): Promise<StoredSourceDocument | undefined> {
  return new Promise((resolve, reject) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(undefined);
        return;
      }
      const record = cursor.value as StoredSourceDocument;
      const matches = record.caseId === caseId
        && record.id.startsWith(`${userId}|`)
        && (sourceDocumentId ? record.documentId === sourceDocumentId : record.fileName === fileName);
      if (matches) resolve(record);
      else cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
