import React, { lazy, Suspense, useState, useMemo, useEffect } from 'react';
import { CaseMetadata } from './types/case';
import { BankAccount, StandardTransaction } from './types/transaction';
import { CaseEvaluationReport } from './types/evidence';
import { User } from './types/user';
import { LawFlowEngine } from './engine/engine';
import { Header } from './components/Header';
import { AuthScreen } from './components/AuthScreen';
import { CaseManagerModal } from './components/CaseManagerModal';
import { WorkflowStepper, WorkflowStep } from './components/WorkflowStepper';
import { Step0CaseSetup } from './components/Step0CaseSetup';
import { Step2Verify } from './components/Step2Verify';
import { Step3PreAnnotation } from './components/Step3PreAnnotation';
import { Step5PostAnnotation } from './components/Step5PostAnnotation';
import { getCurrentSessionUser, logoutUser } from './store/authStore';
import { CaseRecord, saveCaseRecord, listSavedCases } from './store/caseStore';
import { normalizeRecognizedData } from './utils/recognizedDataNormalizer';
import { publishAutomationAppState } from './debug/automationBridge';
import { buildEvidenceReviewIssues } from './review/buildEvidenceReviewIssues';
import { blockingRecognitionIssues } from './review/recognitionCompleteness';

const Step1Upload = lazy(() => import('./components/Step1Upload').then(module => ({ default: module.Step1Upload })));
const Step4Compute = lazy(() => import('./components/Step4Compute').then(module => ({ default: module.Step4Compute })));
const Step6Export = lazy(() => import('./components/Step6Export').then(module => ({ default: module.Step6Export })));

function createBlankCase(): CaseMetadata {
  return {
    id: `CASE_${Date.now()}`,
    caseNumber: '',
    courtName: '',
    applicantName: '',
    respondentName: '',
    targetAmount: 0,
    createdAt: new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString().slice(0, 10),
    timeline: {
      customNodes: []
    },
    declaredAssets: []
  };
}

function safeWorkflowStep(requested: unknown, transactionCount: number): WorkflowStep {
  const parsed = Number(requested);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 6) return 0;
  if (transactionCount === 0 && parsed > 1) return 1;
  return parsed as WorkflowStep;
}

export const App: React.FC = () => {
  const engine = useMemo(() => new LawFlowEngine(), []);

  // Auth State
  const [currentUser, setCurrentUser] = useState<User | null>(getCurrentSessionUser());

  // Active Case State
  const [caseMeta, setCaseMeta] = useState<CaseMetadata>(createBlankCase());
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [transactions, setTransactions] = useState<StandardTransaction[]>([]);
  const [evaluationReport, setEvaluationReport] = useState<CaseEvaluationReport | null>(null);
  const currentAnalysisFingerprint = useMemo(
    () => engine.fingerprint(caseMeta, transactions, accounts),
    [engine, caseMeta, transactions, accounts]
  );
  const recognitionBlockers = useMemo(
    () => blockingRecognitionIssues(accounts, transactions),
    [accounts, transactions]
  );
  const recognitionBlocked = recognitionBlockers.length > 0;
  const freshEvaluationReport = !recognitionBlocked && evaluationReport?.analysisFingerprint === currentAnalysisFingerprint
    ? evaluationReport
    : null;

  const [currentStep, setCurrentStep] = useState<WorkflowStep>(0);
  const [completedSteps, setCompletedSteps] = useState<Set<WorkflowStep>>(new Set());
  const [isCaseManagerOpen, setIsCaseManagerOpen] = useState(false);
  const [hydratedUserId, setHydratedUserId] = useState<string | null>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [saveRetryToken, setSaveRetryToken] = useState(0);
  const activeCaseStorageKey = currentUser ? `LAWFLOW_ACTIVE_CASE_DATA_v2_${currentUser.id}` : '';

  // IndexedDB is authoritative for large evidence sets. localStorage keeps only small UI/session metadata.
  useEffect(() => {
    let cancelled = false;
    setHydratedUserId(null);
    if (!currentUser) return () => { cancelled = true; };
    const userId = currentUser.id;

    let session: any = null;
    try {
      const saved = localStorage.getItem(`LAWFLOW_ACTIVE_CASE_DATA_v2_${userId}`);
      if (saved) session = JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to restore active case from storage:', e);
    }

    async function loadUserCases() {
      const savedList = await listSavedCases(userId);
      if (cancelled) return;
      const requestedCaseId = session?.caseId || session?.caseMeta?.id;
      const active = savedList.find(record => record.metadata.id === requestedCaseId) || savedList[0];
      if (active) {
        const normalized = normalizeRecognizedData(active.accounts || [], active.transactions || []);
        const restoredRecognitionBlocked = blockingRecognitionIssues(normalized.accounts, normalized.transactions).length > 0;
        setCaseMeta(active.metadata);
        setAccounts(normalized.accounts);
        setTransactions(normalized.transactions);
        const requestedStep = safeWorkflowStep(session?.currentStep, normalized.transactions.length);
        const restoredStep = restoredRecognitionBlocked && requestedStep > 2 ? 2 : requestedStep;
        setCurrentStep(restoredStep);
        if (session?.completedSteps) {
          setCompletedSteps(new Set((session.completedSteps as WorkflowStep[]).filter(step => (
            (normalized.transactions.length > 0 || step <= 1)
            && (!restoredRecognitionBlocked || step <= 1)
          ))));
        }
        if (normalized.transactions.length > 0
          && !restoredRecognitionBlocked) {
          const { report, processedTransactions } = engine.evaluateCase(
            active.metadata,
            normalized.transactions,
            normalized.accounts,
            active.evaluationReport
          );
          setEvaluationReport(report);
          setTransactions(processedTransactions);
        } else {
          setEvaluationReport(null);
        }
      } else {
        setCaseMeta(createBlankCase());
        setAccounts([]);
        setTransactions([]);
        setEvaluationReport(null);
        setCurrentStep(0);
        setCompletedSteps(new Set());
      }
      setHydratedUserId(userId);
    }
    loadUserCases();
    return () => { cancelled = true; };
  }, [currentUser]);

  // A report is valid only for the exact canonical facts that produced it.
  // Any transaction/account/case edit changes the fingerprint, hides the stale
  // report immediately, and schedules a complete recalculation.
  useEffect(() => {
    if (!transactions.length) return;
    if (currentUser && hydratedUserId !== currentUser.id) return;
    if (recognitionBlocked) {
      if (evaluationReport) setEvaluationReport(null);
      return;
    }
    if (evaluationReport?.analysisFingerprint === currentAnalysisFingerprint) return;
    const { report, processedTransactions } = engine.evaluateCase(
      caseMeta,
      transactions,
      accounts,
      evaluationReport
    );
    setEvaluationReport(report);
    setTransactions(processedTransactions);
  }, [currentAnalysisFingerprint, hydratedUserId, currentUser?.id, recognitionBlocked]);

  // Auto-Save active case to localStorage & IndexedDB on every change
  useEffect(() => {
    if (!currentUser || hydratedUserId !== currentUser.id) return;

    try {
      const payload = {
        caseId: caseMeta.id,
        currentStep,
        completedSteps: Array.from(completedSteps),
        updatedAt: new Date().toISOString()
      };
      localStorage.setItem(activeCaseStorageKey, JSON.stringify(payload));
    } catch (e) {
      console.warn('Failed to save to localStorage:', e);
      setPersistenceError('当前案件的页面位置未能保存，但案件数据仍会继续尝试保存。');
    }

    if (caseMeta && caseMeta.id && (caseMeta.caseNumber || caseMeta.respondentName || transactions.length > 0)) {
      const record: CaseRecord = {
        metadata: caseMeta,
        accounts,
        transactions,
        evaluationReport: freshEvaluationReport,
        userId: currentUser.id,
        updatedAt: new Date().toISOString()
      };
      saveCaseRecord(record)
        .then(() => setPersistenceError(null))
        .catch(err => {
          console.warn('Auto-save error', err);
          setPersistenceError('当前案件的最新修改尚未保存。请保持页面打开并点击“重新保存”。');
        });
    }
  }, [caseMeta, accounts, transactions, currentStep, completedSteps, freshEvaluationReport, currentUser, hydratedUserId, activeCaseStorageKey, saveRetryToken]);

  const handleNewCase = () => {
    const blankCase = createBlankCase();
    setCaseMeta(blankCase);
    setAccounts([]);
    setTransactions([]);
    setEvaluationReport(null);
    setCurrentStep(0);
    setCompletedSteps(new Set());
    if (activeCaseStorageKey) localStorage.removeItem(activeCaseStorageKey);
  };

  const handleSelectCaseFromStore = (record: CaseRecord) => {
    const normalized = normalizeRecognizedData(record.accounts || [], record.transactions || []);
    setCaseMeta(record.metadata);
    setAccounts(normalized.accounts);
    setTransactions(normalized.transactions);
    if (normalized.transactions.length
      && blockingRecognitionIssues(normalized.accounts, normalized.transactions).length === 0) {
      const { report, processedTransactions } = engine.evaluateCase(record.metadata, normalized.transactions, normalized.accounts, record.evaluationReport);
      setEvaluationReport(report);
      setTransactions(processedTransactions);
    } else {
      setEvaluationReport(null);
    }
    const hasCaseIdentity = Boolean(record.metadata.respondentName?.trim() || record.metadata.caseNumber?.trim());
    const hasTransactions = normalized.transactions.length > 0;
    const hasRecognitionBlockers = blockingRecognitionIssues(normalized.accounts, normalized.transactions).length > 0;
    setCurrentStep(hasTransactions ? (hasRecognitionBlockers ? 2 : 4) : hasCaseIdentity || normalized.accounts.length > 0 ? 1 : 0);
    setCompletedSteps(new Set(hasTransactions
      ? (hasRecognitionBlockers ? [0, 1] : [0, 1, 2, 3, 4])
      : hasCaseIdentity ? [0] : []));
  };

  const handleLogout = () => {
    logoutUser();
    setCaseMeta(createBlankCase());
    setAccounts([]);
    setTransactions([]);
    setEvaluationReport(null);
    setCurrentStep(0);
    setCompletedSteps(new Set());
    setHydratedUserId(null);
    setCurrentUser(null);
  };

  const markStepCompleted = (step: WorkflowStep) => {
    setCompletedSteps(prev => new Set([...prev, step]));
  };

  const goToStep = (step: WorkflowStep) => {
    if (step > 2 && recognitionBlocked) {
      setCurrentStep(2);
      window.alert(`还有 ${recognitionBlockers.length} 个页面未完成识别。请先重新识别失败页，或在原件核对中补录并完成这些页面。`);
      return;
    }
    setCurrentStep(safeWorkflowStep(step, transactions.length));
  };

  const handleTransactionsUpdated = (updatedTransactions: StandardTransaction[]) => {
    if (!updatedTransactions.length) {
      setTransactions([]);
      setEvaluationReport(null);
      return;
    }
    if (blockingRecognitionIssues(accounts, updatedTransactions).length > 0) {
      setTransactions(updatedTransactions);
      setEvaluationReport(null);
      return;
    }
    const { report, processedTransactions } = engine.evaluateCase(
      caseMeta,
      updatedTransactions,
      accounts,
      evaluationReport
    );
    setTransactions(processedTransactions);
    setEvaluationReport(report);
  };

  useEffect(() => {
    publishAutomationAppState({
      ready: Boolean(currentUser && hydratedUserId === currentUser.id),
      currentStep,
      caseMetadata: caseMeta,
      accounts,
      transactions,
      reviewIssues: accounts.flatMap(account => buildEvidenceReviewIssues(account, transactions)),
      evaluationReport: freshEvaluationReport
    });
  }, [currentUser, hydratedUserId, currentStep, caseMeta, accounts, transactions, freshEvaluationReport]);

  if (!currentUser) {
    return <AuthScreen onAuthenticated={user => setCurrentUser(user)} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      <Header
        currentCase={caseMeta}
        currentUser={currentUser}
        onNewCase={handleNewCase}
        onOpenCaseManager={() => setIsCaseManagerOpen(true)}
        onLogout={handleLogout}
      />

      <WorkflowStepper
        currentStep={currentStep}
        onSelectStep={goToStep}
        completedSteps={completedSteps}
      />

      <main className="flex-1 pb-16">
        {persistenceError && (
          <div role="alert" className="max-w-5xl mx-auto mt-5 px-4 sm:px-6">
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 flex items-center justify-between gap-4 text-xs text-rose-900">
              <div>
                <div className="font-semibold">案件尚未保存</div>
                <div className="mt-0.5 text-rose-800">{persistenceError}</div>
              </div>
              <button
                type="button"
                onClick={() => setSaveRetryToken(value => value + 1)}
                className="px-3 py-1.5 rounded-lg border border-rose-300 bg-white hover:bg-rose-100 font-medium flex-shrink-0"
              >
                重新保存
              </button>
            </div>
          </div>
        )}
        <Suspense fallback={<div className="max-w-5xl mx-auto p-8 text-sm text-slate-500">正在加载当前工作步骤…</div>}>
        {currentStep === 0 && (
          <Step0CaseSetup
            caseMeta={caseMeta}
            onChange={setCaseMeta}
            onNext={() => {
              markStepCompleted(0);
              goToStep(1);
            }}
          />
        )}

        {currentStep === 1 && (
          <Step1Upload
            caseId={caseMeta.id}
            caseRespondentName={caseMeta.respondentName}
            accounts={accounts}
            transactions={transactions}
            onDataUpdated={(accs, txs) => {
              const normalized = normalizeRecognizedData(accs, txs);
              setAccounts(normalized.accounts);
              setTransactions(normalized.transactions);
            }}
            onPrev={() => goToStep(0)}
            onNext={() => {
              markStepCompleted(1);
              goToStep(2);
            }}
          />
        )}

        {currentStep === 2 && (
          <Step2Verify
            caseId={caseMeta.id}
            accounts={accounts}
            transactions={transactions}
            onAccountsUpdated={setAccounts}
            onTransactionsUpdated={handleTransactionsUpdated}
            onPrev={() => goToStep(1)}
            onNext={() => {
              markStepCompleted(2);
              goToStep(3);
            }}
          />
        )}

        {currentStep === 3 && (
          <Step3PreAnnotation
            caseMeta={caseMeta}
            accounts={accounts}
            onCaseMetaUpdated={setCaseMeta}
            onAccountsUpdated={setAccounts}
            onPrev={() => goToStep(2)}
            onNext={() => {
              markStepCompleted(3);
              goToStep(4);
            }}
          />
        )}

        {currentStep === 4 && (
          <Step4Compute
            caseMeta={caseMeta}
            accounts={accounts}
            transactions={transactions}
            engine={engine}
            evaluationReport={freshEvaluationReport}
            onEvaluationComplete={(report, procTx) => {
              setEvaluationReport(report);
              setTransactions(procTx);
              markStepCompleted(4);
            }}
            onPrev={() => goToStep(3)}
            onNext={() => {
              markStepCompleted(4);
              goToStep(5);
            }}
          />
        )}

        {(currentStep === 5 || currentStep === 6) && transactions.length > 0 && !freshEvaluationReport && (
          <div className="max-w-3xl mx-auto mt-10 rounded-2xl border border-blue-200 bg-blue-50 px-6 py-8 text-center">
            <div className="text-sm font-semibold text-blue-950">流水已发生变化，正在重新计算全部分析结果…</div>
            <div className="mt-2 text-xs text-blue-700">旧报告已失效；完成平账、内部转账、资金流向和风险规则重算后会自动恢复。</div>
          </div>
        )}

        {currentStep === 5 && freshEvaluationReport && (
          <Step5PostAnnotation
            evaluationReport={freshEvaluationReport}
            transactions={transactions}
            onMatchesUpdated={updatedMatches => {
              setEvaluationReport({
                ...freshEvaluationReport,
                matches: updatedMatches
              });
            }}
            onTransactionsUpdated={handleTransactionsUpdated}
            onPrev={() => goToStep(4)}
            onNext={() => {
              markStepCompleted(5);
              goToStep(6);
            }}
          />
        )}

        {currentStep === 6 && freshEvaluationReport && (
          <Step6Export
            caseMeta={caseMeta}
            evaluationReport={freshEvaluationReport}
            transactions={transactions}
            accounts={accounts}
            onPrev={() => goToStep(5)}
          />
        )}
        </Suspense>
      </main>

      <footer className="bg-white border-t border-slate-200 py-4 text-center text-xs text-slate-400">
        © 执析宝 (LawFlow) · 执行律师银行流水智能穿透与司法取证系统 · 系统识别结果须经律师结合原件复核
      </footer>

      {/* Case Manager Modal */}
      <CaseManagerModal
        isOpen={isCaseManagerOpen}
        onClose={() => setIsCaseManagerOpen(false)}
        currentCaseId={caseMeta.id}
        onSelectCase={handleSelectCaseFromStore}
        onNewCase={handleNewCase}
      />
    </div>
  );
};

export default App;
