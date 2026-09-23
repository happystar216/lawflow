import { getCurrentSessionUser } from './authStore';
import { recognitionScopeKey, RESUME_TTL_MS, type RecognitionResumeStore } from '../recognition/resume';
import type { MinerUPageCheckpoint } from '../parsers/mineruBankStatementParser';
import type { MinerUStructuredDocument } from '../parsers/mineruResultParser';
import type { StatementPage } from '../recognition/statementPlan';

const DB_NAME = 'LawFlow_Recognition_Checkpoints_v1';
const STORE = 'checkpoints';
interface RecordEntry {
  id: string;
  scope: string;
  userId: string;
  caseId: string;
  documentId: string;
  fileName: string;
  savedAt: number;
  inputKey?: string;
  value: MinerUStructuredDocument | MinerUPageCheckpoint | StatementPage[];
}

async function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => Promise<T> | T): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const transaction = db.transaction(STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('检查点保存失败'));
    });
    // Attach rejection handling immediately, including when action fails first.
    const [value] = await Promise.all([action(transaction.objectStore(STORE)), done]);
    return value;
  } finally { db.close(); }
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function createRecognitionCheckpointStore(
  caseId: string, documentId: string, fileName: string, respondent: string
): RecognitionResumeStore {
  // Capture the user at run start, not after an asynchronous request completes.
  const userId = getCurrentSessionUser()?.id || 'DEFAULT_USER';
  const scope = recognitionScopeKey(userId, caseId, documentId, respondent);
  const read = async (suffix: string, inputKey?: string) => {
    const record = await withStore('readonly', store => requestValue<RecordEntry | undefined>(store.get(`${scope}:${suffix}`)));
    if (!record || record.scope !== scope || record.inputKey !== inputKey
      || Date.now() - record.savedAt > RESUME_TTL_MS || record.savedAt > Date.now()) return undefined;
    return record.value;
  };
  const write = (suffix: string, value: RecordEntry['value'], inputKey?: string) => withStore('readwrite', store => {
    store.put({ id: `${scope}:${suffix}`, scope, userId, caseId, documentId, fileName,
      savedAt: Date.now(), inputKey, value } satisfies RecordEntry);
  });
  return {
    loadDocument: async () => await read('document') as MinerUStructuredDocument | undefined,
    saveDocument: document => write('document', document),
    loadPage: async (page, inputKey) => await read(`page:${page}`, inputKey) as MinerUPageCheckpoint | undefined,
    savePage: (checkpoint, inputKey) => write(`page:${checkpoint.page}`, checkpoint, inputKey),
    loadPlanningBatch: async (firstPage, inputKey) => await read(`plan:${firstPage}`, inputKey) as StatementPage[] | undefined,
    savePlanningBatch: (firstPage, inputKey, pages) => write(`plan:${firstPage}`, pages, inputKey)
  };
}

/** Delete only this user's scoped cache, plus expired cache records. No case data is changed. */
export async function clearRecognitionCheckpoints(caseId: string, fileName?: string, documentId?: string): Promise<void> {
  const userId = getCurrentSessionUser()?.id || 'DEFAULT_USER';
  await withStore('readwrite', store => new Promise<void>((resolve, reject) => {
    const request = store.openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      const record = cursor.value as RecordEntry;
      const matches = record.userId === userId && record.caseId === caseId
        && (documentId ? record.documentId === documentId : !fileName || record.fileName === fileName);
      if (matches || (record.userId === userId && Date.now() - record.savedAt > RESUME_TTL_MS)) cursor.delete();
      cursor.continue();
    };
  }));
}
