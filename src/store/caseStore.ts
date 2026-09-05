import { CaseMetadata } from '../types/case';
import { BankAccount, StandardTransaction } from '../types/transaction';
import { CaseEvaluationReport } from '../types/evidence';
import { getCurrentSessionUser } from './authStore';
import { normalizeRecognizedData } from '../utils/recognizedDataNormalizer';

export interface CaseRecord {
  metadata: CaseMetadata;
  accounts: BankAccount[];
  transactions: StandardTransaction[];
  evaluationReport?: CaseEvaluationReport | null;
  updatedAt: string;
  userId?: string;
}

const DB_NAME = 'LawFlow_Cases_DB_v2';
const DB_VERSION = 1;
const STORE_NAME = 'cases';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB not supported in this browser'));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'metadata.id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Lists cases belonging to the currently logged in user.
 */
export async function listSavedCases(targetUserId?: string): Promise<CaseRecord[]> {
  const currentUser = getCurrentSessionUser();
  const userId = targetUserId || currentUser?.id || 'DEFAULT_USER';

  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const records = req.result as CaseRecord[];
        // Filter by user if userId matches
        const userCases = records.filter(r => !r.userId || r.userId === userId || r.userId === currentUser?.email);
        resolve(userCases.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('Falling back to localStorage for case store', err);
    const local = localStorage.getItem(`LAWFLOW_LOCAL_CASES_${userId}`);
    if (local) {
      try {
        return JSON.parse(local);
      } catch (e) {
        return [];
      }
    }
    return [];
  }
}

/**
 * Saves or updates a case record for the current user.
 */
export async function saveCaseRecord(record: CaseRecord): Promise<void> {
  const currentUser = getCurrentSessionUser();
  const userId = currentUser?.id || 'DEFAULT_USER';

  const updatedRecord = {
    ...record,
    userId,
    updatedAt: new Date().toISOString()
  };

  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(updatedRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    const cases = await listSavedCases(userId);
    const idx = cases.findIndex(c => c.metadata.id === record.metadata.id);
    if (idx >= 0) {
      cases[idx] = updatedRecord;
    } else {
      cases.push(updatedRecord);
    }
    localStorage.setItem(`LAWFLOW_LOCAL_CASES_${userId}`, JSON.stringify(cases));
  }
}

/**
 * Deletes a case from persistent storage.
 */
export async function deleteCaseRecord(caseId: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(caseId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    const currentUser = getCurrentSessionUser();
    const userId = currentUser?.id || 'DEFAULT_USER';
    const cases = await listSavedCases(userId);
    const filtered = cases.filter(c => c.metadata.id !== caseId);
    localStorage.setItem(`LAWFLOW_LOCAL_CASES_${userId}`, JSON.stringify(filtered));
  }
}

/**
 * Exports full case data as a JSON file for backup or cross-device transfer.
 */
export function exportCaseBackupJson(record: CaseRecord): void {
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(record, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute('href', dataStr);
  const safeName = record.metadata.caseNumber || record.metadata.respondentName || '案件备份';
  downloadAnchor.setAttribute('download', `执析宝备份_${safeName}_${new Date().toISOString().slice(0, 10)}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

/**
 * Parses and validates an imported case JSON file.
 */
export function importCaseBackupJson(jsonString: string): CaseRecord {
  const parsed = JSON.parse(jsonString);
  if (!parsed.metadata || !parsed.metadata.id) {
    throw new Error('无效的案件备份文件格式');
  }
  const currentUser = getCurrentSessionUser();
  const normalized = normalizeRecognizedData(parsed.accounts || [], parsed.transactions || []);
  return {
    metadata: parsed.metadata,
    accounts: normalized.accounts,
    transactions: normalized.transactions,
    evaluationReport: parsed.evaluationReport || null,
    userId: currentUser?.id || 'DEFAULT_USER',
    updatedAt: new Date().toISOString()
  };
}
