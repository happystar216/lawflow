import React, { useState, useMemo, useEffect, useRef } from 'react';
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
import { Step1Upload } from './components/Step1Upload';
import { Step2Verify } from './components/Step2Verify';
import { Step3PreAnnotation } from './components/Step3PreAnnotation';
import { Step4Compute } from './components/Step4Compute';
import { Step5PostAnnotation } from './components/Step5PostAnnotation';
import { Step6Export } from './components/Step6Export';
import { getCurrentSessionUser, logoutUser } from './store/authStore';
import { CaseRecord, saveCaseRecord, listSavedCases } from './store/caseStore';
import { normalizeRecognizedData } from './utils/recognizedDataNormalizer';

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

  const isInitialMount = useRef(true);

  const LOCAL_STORAGE_ACTIVE_CASE = 'LAWFLOW_ACTIVE_CASE_DATA_v1';

  // IndexedDB is authoritative for large evidence sets. localStorage keeps only small UI/session metadata.
  useEffect(() => {
    let session: any = null;
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_ACTIVE_CASE);
      if (saved) session = JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to restore active case from storage:', e);
    }

    if (!currentUser) {
      // Backward compatibility for a legacy full localStorage record.
      if (session?.caseMeta) {
        const normalized = normalizeRecognizedData(session.accounts || [], session.transactions || []);
        setCaseMeta(session.caseMeta); setAccounts(normalized.accounts); setTransactions(normalized.transactions);
        setEvaluationReport(session.evaluationReport || null);
      }
      return;
    }

    async function loadUserCases() {
      const savedList = await listSavedCases(currentUser?.id);
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
      } else if (session?.caseMeta) {
        const normalized = normalizeRecognizedData(session.accounts || [], session.transactions || []);
        setCaseMeta(session.caseMeta); setAccounts(normalized.accounts); setTransactions(normalized.transactions);
        setEvaluationReport(session.evaluationReport || null);
      }
    }
    loadUserCases();
  }, [currentUser]);

  // Auto-Save active case to localStorage & IndexedDB on every change
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    try {
      const payload = {
        caseId: caseMeta.id,
        currentStep,
        completedSteps: Array.from(completedSteps),
        updatedAt: new Date().toISOString()
      };
      localStorage.setItem(LOCAL_STORAGE_ACTIVE_CASE, JSON.stringify(payload));
    } catch (e) {
      console.warn('Failed to save to localStorage:', e);
    }

    if (currentUser && caseMeta && caseMeta.id && (caseMeta.caseNumber || caseMeta.respondentName || transactions.length > 0)) {
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
  }, [caseMeta, accounts, transactions, currentStep, completedSteps, evaluationReport, currentUser]);

  const handleNewCase = () => {
    const blankCase = createBlankCase();
    setCaseMeta(blankCase);
    setAccounts([]);
    setTransactions([]);
    setEvaluationReport(null);
    setCurrentStep(0);
    setCompletedSteps(new Set());
    localStorage.removeItem(LOCAL_STORAGE_ACTIVE_CASE);
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
            accounts={accounts}
            transactions={transactions}
            onDataUpdated={(accs, txs) => {
              setAccounts(accs);
              setTransactions(txs);
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
      </main>

      <footer className="bg-white border-t border-slate-200 py-4 text-center text-xs text-slate-400">
        © 执析宝 (LawFlow) · 执行律师银行流水智能穿透与司法取证系统 · 本地沙箱加密运算
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
