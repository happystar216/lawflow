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

export const App: React.FC = () => {
  const engine = useMemo(() => new LawFlowEngine(), []);

  // Auth State
  const [currentUser, setCurrentUser] = useState<User | null>(getCurrentSessionUser());

  // Active Case State
  const [caseMeta, setCaseMeta] = useState<CaseMetadata>(createBlankCase());
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [transactions, setTransactions] = useState<StandardTransaction[]>([]);
  const [evaluationReport, setEvaluationReport] = useState<CaseEvaluationReport | null>(null);

  const [currentStep, setCurrentStep] = useState<WorkflowStep>(0);
  const [completedSteps, setCompletedSteps] = useState<Set<WorkflowStep>>(new Set());
  const [isCaseManagerOpen, setIsCaseManagerOpen] = useState(false);
  const [hydratedUserId, setHydratedUserId] = useState<string | null>(null);
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
        setCaseMeta(active.metadata);
        setAccounts(normalized.accounts);
        setTransactions(normalized.transactions);
        if (session?.currentStep !== undefined) setCurrentStep(session.currentStep);
        if (session?.completedSteps) setCompletedSteps(new Set(session.completedSteps));
        if (normalized.transactions.length > 0) {
          const { report, processedTransactions } = engine.evaluateCase(
            active.metadata,
            normalized.transactions,
            normalized.accounts
          );
          setEvaluationReport(report);
          setTransactions(processedTransactions);
        } else {
          setEvaluationReport(active.evaluationReport || null);
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
    }

    if (caseMeta && caseMeta.id && (caseMeta.caseNumber || caseMeta.respondentName || transactions.length > 0)) {
      const record: CaseRecord = {
        metadata: caseMeta,
        accounts,
        transactions,
        evaluationReport,
        userId: currentUser.id,
        updatedAt: new Date().toISOString()
      };
      saveCaseRecord(record).catch(err => console.warn('Auto-save error', err));
    }
  }, [caseMeta, accounts, transactions, currentStep, completedSteps, evaluationReport, currentUser, hydratedUserId, activeCaseStorageKey]);

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
    if (normalized.transactions.length) {
      const { report, processedTransactions } = engine.evaluateCase(record.metadata, normalized.transactions, normalized.accounts);
      setEvaluationReport(report);
      setTransactions(processedTransactions);
    } else {
      setEvaluationReport(record.evaluationReport || null);
    }
    setCurrentStep(record.transactions?.length > 0 ? 4 : 0);
    setCompletedSteps(new Set([0, 1, 2, 3, 4, 5]));
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
    setCurrentStep(step);
  };

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
            onTransactionsUpdated={setTransactions}
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
            evaluationReport={evaluationReport}
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

        {currentStep === 5 && evaluationReport && (
          <Step5PostAnnotation
            evaluationReport={evaluationReport}
            transactions={transactions}
            onMatchesUpdated={updatedMatches => {
              setEvaluationReport({
                ...evaluationReport,
                matches: updatedMatches
              });
            }}
            onTransactionsUpdated={setTransactions}
            onPrev={() => goToStep(4)}
            onNext={() => {
              markStepCompleted(5);
              goToStep(6);
            }}
          />
        )}

        {currentStep === 6 && evaluationReport && (
          <Step6Export
            caseMeta={caseMeta}
            evaluationReport={evaluationReport}
            transactions={transactions}
            accounts={accounts}
            onPrev={() => goToStep(5)}
          />
        )}
        </Suspense>
      </main>

      <footer className="bg-white border-t border-slate-200 py-4 text-center text-xs text-slate-400">
        © 执析宝 (LawFlow) · 执行律师银行流水智能穿透与司法取证系统 · AI 结果须经律师结合原件复核
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
