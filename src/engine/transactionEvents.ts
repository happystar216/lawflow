import { StandardTransaction } from '../types/transaction';
import { isReliableAccountNumber, normalizeAccountIdentityPart } from '../utils/accountIdentity';
import { sourceIdentity } from '../utils/evidenceProvenance';

export interface CanonicalTransactionEvent {
  id: string;
  representative: StandardTransaction;
  observations: StandardTransaction[];
  confidence: number;
  reasons: string[];
}

export interface CanonicalTransactionResult {
  events: CanonicalTransactionEvent[];
  canonicalTransactions: StandardTransaction[];
  eventIdByObservationId: Map<string, string>;
  representativeIdByObservationId: Map<string, string>;
}

export function canonicalizeTransactionEvents(transactions: StandardTransaction[]): CanonicalTransactionResult {
  const observations = transactions.map(clearDerivedEventFields);
  const events: CanonicalTransactionEvent[] = [];

  for (const observation of observations) {
    const declaredTargetId = observation.duplicateOfTransactionId;
    const declaredEvent = declaredTargetId
      ? events.find(event => event.observations.some(item => item.id === declaredTargetId))
      : undefined;
    if (declaredEvent) {
      declaredEvent.observations.push(observation);
      declaredEvent.representative = chooseRepresentative(declaredEvent.observations);
      declaredEvent.confidence = Math.min(declaredEvent.confidence, 0.98);
      declaredEvent.reasons = [...new Set([...declaredEvent.reasons, '同一原文件中的重复版式记录'])];
      continue;
    }
    let best: { event: CanonicalTransactionEvent; score: DuplicateScore } | undefined;
    for (const event of events) {
      if (event.observations.some(item => sourceIdentity(item) === sourceIdentity(observation))) continue;
      const score = duplicateScore(event.representative, observation);
      if (!score || (best && score.points <= best.score.points)) continue;
      best = { event, score };
    }
    if (best) {
      best.event.observations.push(observation);
      const currentRepresentative = chooseRepresentative(best.event.observations);
      best.event.representative = currentRepresentative;
      best.event.confidence = Math.min(best.event.confidence, best.score.confidence);
      best.event.reasons = [...new Set([...best.event.reasons, ...best.score.reasons])];
    } else {
      events.push({
        id: '',
        representative: observation,
        observations: [observation],
        confidence: 1,
        reasons: []
      });
    }
  }

  const eventIdByObservationId = new Map<string, string>();
  const representativeIdByObservationId = new Map<string, string>();
  for (const event of events) {
    event.id = transactionEventId(event.representative);
    for (const observation of event.observations) {
      eventIdByObservationId.set(observation.id, event.id);
      representativeIdByObservationId.set(observation.id, event.representative.id);
    }
  }
  return {
    events,
    canonicalTransactions: events.map(event => {
      const representative = { ...event.representative, analysisEventId: event.id };
      delete representative.duplicateOfTransactionId;
      delete representative.excludedFromAnalysis;
      return representative;
    }),
    eventIdByObservationId,
    representativeIdByObservationId
  };
}

interface DuplicateScore {
  points: number;
  confidence: number;
  reasons: string[];
}

function duplicateScore(left: StandardTransaction, right: StandardTransaction): DuplicateScore | undefined {
  if (sourceIdentity(left) === sourceIdentity(right)) return undefined;
  if (!sameReliableAccount(left, right)) return undefined;
  if (left.transactionDate.slice(0, 10) !== right.transactionDate.slice(0, 10)) return undefined;
  if (left.direction === 'UNKNOWN' || right.direction === 'UNKNOWN' || left.direction !== right.direction) return undefined;
  if (toCents(left.amount) !== toCents(right.amount)) return undefined;

  let points = 0;
  const reasons: string[] = ['账号、日期、方向和金额一致'];
  const leftTime = detailedTime(left.transactionTime);
  const rightTime = detailedTime(right.transactionTime);
  if (leftTime && rightTime) {
    if (leftTime !== rightTime) return undefined;
    points += 4;
    reasons.push('交易时间一致');
  }
  const leftHasBalance = left.balanceAvailable !== false && Number.isFinite(left.balance);
  const rightHasBalance = right.balanceAvailable !== false && Number.isFinite(right.balance);
  if (leftHasBalance && rightHasBalance) {
    if (toCents(left.balance) !== toCents(right.balance)) return undefined;
    points += 4;
    reasons.push('交易后余额一致');
  }
  const leftCounterpartyAccount = normalizeAccountIdentityPart(left.counterpartyAccount || '');
  const rightCounterpartyAccount = normalizeAccountIdentityPart(right.counterpartyAccount || '');
  if (leftCounterpartyAccount && rightCounterpartyAccount) {
    if (leftCounterpartyAccount !== rightCounterpartyAccount) return undefined;
    points += 3;
    reasons.push('对手账号一致');
  }
  const leftSummary = normalizedText(left.summary);
  const rightSummary = normalizedText(right.summary);
  if (leftSummary && rightSummary && textCompatible(leftSummary, rightSummary)) {
    points += 1;
    reasons.push('摘要一致');
  }
  const leftCounterparty = normalizedText(left.counterpartyName);
  const rightCounterparty = normalizedText(right.counterpartyName);
  if (leftCounterparty && rightCounterparty && textCompatible(leftCounterparty, rightCounterparty)) {
    points += 1;
    reasons.push('对手方一致');
  }
  if (normalizedText(left.rawText) && normalizedText(left.rawText) === normalizedText(right.rawText)) {
    points += 2;
    reasons.push('识别原文一致');
  }

  // Date + amount alone is unsafe: recurring fees and same-day split payments are common.
  if (points < 4) return undefined;
  return { points, confidence: Math.min(0.99, 0.8 + points * 0.02), reasons };
}

function sameReliableAccount(left: StandardTransaction, right: StandardTransaction): boolean {
  if (!isReliableAccountNumber(left.accountNumber) || !isReliableAccountNumber(right.accountNumber)) return false;
  return normalizeAccountIdentityPart(left.accountNumber) === normalizeAccountIdentityPart(right.accountNumber);
}

function chooseRepresentative(observations: StandardTransaction[]): StandardTransaction {
  return [...observations].sort((left, right) => representativeScore(right) - representativeScore(left)
    || left.id.localeCompare(right.id))[0];
}

function representativeScore(transaction: StandardTransaction): number {
  return (transaction.reviewStatus === 'VERIFIED' || transaction.reviewStatus === 'CORRECTED' ? 100 : 0)
    + Math.round((transaction.extractionConfidence || 0) * 20)
    + (transaction.balanceAvailable === false ? 0 : 8)
    + (transaction.counterpartyAccount ? 5 : 0)
    + (transaction.counterpartyName ? 3 : 0)
    + (transaction.summary ? 2 : 0);
}

function clearDerivedEventFields(transaction: StandardTransaction): StandardTransaction {
  const clone = { ...transaction };
  delete clone.analysisEventId;
  return clone;
}

function transactionEventId(transaction: StandardTransaction): string {
  const key = [normalizeAccountIdentityPart(transaction.accountNumber), transaction.transactionTime,
    transaction.direction, transaction.amount.toFixed(2), transaction.balanceAvailable === false ? '' : transaction.balance.toFixed(2),
    normalizeAccountIdentityPart(transaction.counterpartyAccount || ''), normalizedText(transaction.summary), transaction.id].join('|');
  let left = 2166136261;
  let right = 2246822507;
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right ^ (code + index), 3266489909);
  }
  return `event_${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function detailedTime(value: string): string {
  return value.match(/\b(\d{2}:\d{2}(?::\d{2})?)\b/)?.[1] || '';
}

function normalizedText(value?: string): string {
  return (value || '').replace(/[\s\-_@#*|/\\.,:;，。、：；()（）]/g, '').toLowerCase();
}

function textCompatible(left: string, right: string): boolean {
  return left === right || (Math.min(left.length, right.length) >= 4 && (left.includes(right) || right.includes(left)));
}
