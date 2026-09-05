const DB_NAME = 'LawFlow_Source_Documents_v1';
const STORE_NAME = 'documents';

interface StoredSourceDocument {
  id: string;
  caseId: string;
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

export async function saveSourceDocument(caseId: string, file: File): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).put({
    id: `${caseId}|${file.name}`,
    caseId,
    fileName: file.name,
    file,
    savedAt: new Date().toISOString()
  } satisfies StoredSourceDocument);
  await transactionDone(transaction);
  db.close();
}

export async function getSourceDocument(caseId: string, fileName: string): Promise<File | null> {
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(`${caseId}|${fileName}`);
    const record = await new Promise<StoredSourceDocument | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return record?.file || null;
  } catch {
    return null;
  }
}

export async function deleteSourceDocument(caseId: string, fileName: string): Promise<void> {
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(`${caseId}|${fileName}`);
    await transactionDone(transaction);
    db.close();
  } catch {
    // Removing an account must not be blocked by optional local document cleanup.
  }
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
