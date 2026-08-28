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

  // Load user's latest case when user is logged in
  useEffect(() => {
    if (!currentUser) return;

    async function loadUserCases() {
      const savedList = await listSavedCases(currentUser?.id);
      if (savedList.length > 0) {
        const latest = savedList[0];
        setCaseMeta(latest.metadata);
        setAccounts(latest.accounts || []);
        setTransactions(latest.transactions || []);
        if (latest.evaluationReport) {
          setEvaluationReport(latest.evaluationReport);
        } else if ((latest.transactions || []).length > 0) {
          const { report, processedTransactions } = engine.evaluateCase(
            latest.metadata,
            latest.transactions,
            latest.accounts
          );
          setEvaluationReport(report);
          setTransactions(processedTransactions);
        }
        if ((latest.transactions || []).length > 0) {
          setCurrentStep(4);
          setCompletedSteps(new Set([0, 1, 2, 3, 4, 5]));
        }
      } else {
        // Fresh clean case
        handleNewCase();
      }
    }
    loadUserCases();
  }, [currentUser]);

  // Auto-Save active case to IndexedDB CaseStore on modifications
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
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
  }, [caseMeta, accounts, transactions, evaluationReport, currentUser]);

  const handleNewCase = () => {
    const blankCase = createBlankCase();
    setCaseMeta(blankCase);
    setAccounts([]);
    setTransactions([]);
    setEvaluationReport(null);
    setCurrentStep(0);
    setCompletedSteps(new Set());
  };

  const handleSelectCaseFromStore = (record: CaseRecord) => {
    setCaseMeta(record.metadata);
    setAccounts(record.accounts || []);
    setTransactions(record.transactions || []);
    setEvaluationReport(record.evaluationReport || null);
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
            accounts={accounts}
            transactions={transactions}
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
            onPrev={() => goToStep(5)}
          />
        )}
      </main>

      <footer className="bg-white border-t border-slate-200 py-4 text-center text-xs text-slate-400">
        执析宝 (LawFlow) · 执行律师银行流水智能分析与取证系统 · 维护于 GitHub & 部署于 Cloudflare Serverless
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
