import { CaseMetadata } from '../types/case';
import { StandardTransaction } from '../types/transaction';

/**
 * Assigns timeline phase tags to each transaction based on key legal milestone dates.
 */
export function applyTimelineTags(
  transactions: StandardTransaction[],
  caseMeta: CaseMetadata
): StandardTransaction[] {
  const { timeline } = caseMeta;
  const t0 = timeline.debtFormationDate;
  const t1 = timeline.lawsuitFilingDate;
  const t2 = timeline.judgmentEffectiveDate;
  const t3 = timeline.executionFilingDate;
  const t4 = timeline.reportOrderServedDate;
  const t5 = timeline.freezeDate;
  const t6 = timeline.settlementDate;

  return transactions.map(tx => {
    const d = tx.transactionDate;
    let tag = '常规期间';

    // Prioritized legal hierarchy (most critical legal violations first)
    if (t4 && d >= t4) {
      tag = '【报告财产令后】';
    } else if (t6 && d >= t6) {
      tag = '【和解协议后】';
    } else if (t5 && d >= t5) {
      tag = '【查封冻结后】';
    } else if (t3 && d >= t3) {
      tag = '【执行立案后】';
    } else if (t2 && d >= t2) {
      tag = '【判决生效后至立案前】';
    } else if (t1 && d >= t1) {
      tag = '【诉讼保全期间】';
    } else if (t0 && d < t0) {
      tag = '【债务形成前】';
    } else if (t0 && d >= t0) {
      tag = '【债务形成后至起诉前】';
    }

    return {
      ...tx,
      timePhaseTag: tag
    };
  });
}
