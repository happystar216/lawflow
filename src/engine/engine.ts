import { CaseMetadata } from '../types/case';
import { BankAccount, StandardTransaction } from '../types/transaction';
import { CaseEvaluationReport } from '../types/evidence';
import { applyTimelineTags } from './timeline';
import { calculateInternalNetting } from './netting';
import { aggregateCounterparties } from './bilateral';
import { RuleRegistry } from './rules/RuleRegistry';
import { AnomalyMatch } from '../types/rules';
import { buildCaseAnalysisGraph } from './analysisGraph';
import { caseAnalysisFingerprint } from './analysisFingerprint';
import { auditAccountBalance } from '../parsers/sanityChecker';
import { canonicalizeTransactionEvents } from './transactionEvents';
import { accountIdentityKey } from '../utils/accountIdentity';
import { businessAccounts } from '../review/recognitionCompleteness';

export class LawFlowEngine {
  private registry: RuleRegistry;

  constructor(registry?: RuleRegistry) {
    this.registry = registry || new RuleRegistry();
  }

  getRegistry(): RuleRegistry {
    return this.registry;
  }

  getRuleSignature(): string {
    return this.registry.getAllRules()
      .map(rule => `${rule.ruleId}:${rule.enabled ? 1 : 0}:${JSON.stringify(rule.params)}`)
      .sort()
      .join('|');
  }

  fingerprint(caseMeta: CaseMetadata, transactions: StandardTransaction[], accounts: BankAccount[]): string {
    return caseAnalysisFingerprint(caseMeta, transactions, accounts, this.getRuleSignature());
  }

  /**
   * Runs the complete analytical DAG:
   * Layer 1: Timeline projection
   * Layer 2: Multi-account internal netting
   * Layer 3: Counterparty bilateral aggregation
   * Layer 4: Pluggable anomaly rule evaluation
   * Layer 5: Report summarization
   */
  evaluateCase(
    caseMeta: CaseMetadata,
    rawTransactions: StandardTransaction[],
    accounts: BankAccount[],
    previousReport?: CaseEvaluationReport | null
  ): {
    report: CaseEvaluationReport;
    processedTransactions: StandardTransaction[];
  } {
    // 1. Consolidate duplicate observations across source documents and
    // repeated statement layouts within one document.
    // All source rows remain stored; only the representative event enters totals.
    const canonical = canonicalizeTransactionEvents(rawTransactions);

    // 2. Apply Timeline Annotation
    const taggedTx = applyTimelineTags(canonical.canonicalTransactions, caseMeta);

    // 3. Multi-Account Internal Netting
    const { processedTransactions: analyzedTransactions, internalCount, internalTotalAmount, candidates } = calculateInternalNetting(
      taggedTx,
      accounts
    );

    // 4. Bilateral Counterparty Aggregation
    const counterpartySummaries = aggregateCounterparties(
      analyzedTransactions,
      caseMeta.respondentName
    );

    // 5. Run Modular Rules DAG
    const activeRules = this.registry.getAllRules().filter(r => r.enabled);
    const allMatches: AnomalyMatch[] = [];

    const ruleContext = {
      caseMeta,
      allTransactions: analyzedTransactions,
      counterpartySummaries
    };

    activeRules.forEach(rule => {
      try {
        const matches = rule.evaluate(ruleContext);
        allMatches.push(...matches);
      } catch (err) {
        console.error(`Error evaluating rule ${rule.ruleId}:`, err);
      }
    });

    // Lawyer decisions are annotations on stable rule matches. Recalculation
    // regenerates the match facts, then reapplies annotations only when the
    // same deterministic match id still exists.
    const previousMatches = new Map((previousReport?.matches || []).map(match => [match.matchId, match]));
    const annotatedMatches = allMatches.map(match => {
      const previous = previousMatches.get(match.matchId);
      if (!previous) return match;
      return {
        ...match,
        lawyerAdopted: previous.lawyerAdopted,
        lawyerNotes: previous.lawyerNotes,
        verificationStatus: previous.verificationStatus,
        verificationNotes: previous.verificationNotes
      };
    });

    // 6. Calculate macro metrics
    let totalRawIn = 0;
    let totalRawOut = 0;
    let postExecutionTransferAmount = 0;
    let postReportOrderTransferAmount = 0;
    let totalIncomeDuringExecution = 0;

    const t3 = caseMeta.timeline.executionFilingDate;
    const t4 = caseMeta.timeline.reportOrderServedDate;

    analyzedTransactions.forEach(tx => {
      if (tx.direction === 'IN') {
        totalRawIn += tx.amount;
        if (t3 && tx.transactionDate >= t3 && !tx.isInternalTransfer) {
          totalIncomeDuringExecution += tx.amount;
        }
      } else if (tx.direction === 'OUT') {
        totalRawOut += tx.amount;
        if (!tx.isInternalTransfer) {
          if (t3 && tx.transactionDate >= t3) {
            postExecutionTransferAmount += tx.amount;
          }
          if (t4 && tx.transactionDate >= t4) {
            postReportOrderTransferAmount += tx.amount;
          }
        }
      }
    });

    const netExternalIn = totalRawIn - internalTotalAmount;
    const netExternalOut = totalRawOut - internalTotalAmount;

    const targetDebt = caseMeta.targetAmount || 1;
    const solvencyCoverageRate = totalIncomeDuringExecution / targetDebt;

    const analysisGraph = buildCaseAnalysisGraph(accounts, analyzedTransactions, canonical.events);
    const accountAudits = Object.fromEntries(businessAccounts(accounts).map(account => [
      accountIdentityKey(account),
      // Reconcile every statement against its own source rows. Cross-document
      // event consolidation is for case totals, not for altering a statement's audit.
      auditAccountBalance(account, rawTransactions)
    ]));
    const report: CaseEvaluationReport = {
      analysisFingerprint: this.fingerprint(caseMeta, rawTransactions, accounts),
      generatedAt: new Date().toISOString(),
      analysisGraph,
      accountAudits,
      sourceObservationCount: rawTransactions.length,
      canonicalTransactionCount: analyzedTransactions.length,
      duplicateObservationCount: rawTransactions.length - analyzedTransactions.length,
      totalRawTransactions: analyzedTransactions.length,
      totalRawIn,
      totalRawOut,
      internalTransferCount: internalCount,
      internalTransferAmount: internalTotalAmount,
      internalTransferCandidates: candidates,
      netExternalIn,
      netExternalOut,
      postExecutionTransferAmount,
      postReportOrderTransferAmount,
      targetDebtAmount: caseMeta.targetAmount,
      totalIncomeDuringExecution,
      solvencyCoverageRate,
      matches: annotatedMatches,
      counterpartySummaries
    };

    const analyzedById = new Map(analyzedTransactions.map(transaction => [transaction.id, transaction]));
    const processedTransactions = rawTransactions.map(observation => {
      const representativeId = canonical.representativeIdByObservationId.get(observation.id) || observation.id;
      const representative = analyzedById.get(representativeId);
      const analysisEventId = canonical.eventIdByObservationId.get(observation.id);
      if (!representative) return { ...observation, analysisEventId };
      if (observation.id === representativeId) {
        return { ...observation, ...representative, analysisEventId, duplicateOfTransactionId: undefined, excludedFromAnalysis: undefined };
      }
      return {
        ...observation,
        analysisEventId,
        duplicateOfTransactionId: representativeId,
        excludedFromAnalysis: true,
        timePhaseTag: representative.timePhaseTag,
        isInternalTransfer: undefined,
        internalTransferPairId: undefined,
        internalTransferMatchConfidence: undefined,
        internalTransferMatchReason: undefined
      };
    });

    return { report, processedTransactions };
  }
}
