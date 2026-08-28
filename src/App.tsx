import React, { useState, useMemo } from 'react';
import { CaseMetadata } from './types/case';
import { BankAccount, StandardTransaction } from './types/transaction';
import { CaseEvaluationReport } from './types/evidence';
import { LawFlowEngine } from './engine/engine';
import { Header } from './components/Header';
import { WorkflowStepper, WorkflowStep } from './components/WorkflowStepper';
import { Step0CaseSetup } from './components/Step0CaseSetup';
import { Step1Upload } from './components/Step1Upload';
import { Step2Verify } from './components/Step2Verify';
import { Step3PreAnnotation } from './components/Step3PreAnnotation';
import { Step4Compute } from './components/Step4Compute';
import { Step5PostAnnotation } from './components/Step5PostAnnotation';
import { Step6Export } from './components/Step6Export';
import { SAMPLE_CASE, SAMPLE_ACCOUNTS, SAMPLE_TRANSACTIONS } from './demo/sampleData';

export const App: React.FC = () => {
  const engine = useMemo(() => new LawFlowEngine(), []);

  // Initialize with sample demo case by default so user can immediately test
  const [caseMeta, setCaseMeta] = useState<CaseMetadata>(SAMPLE_CASE);
  const [accounts, setAccounts] = useState<BankAccount[]>(SAMPLE_ACCOUNTS);
  const [transactions, setTransactions] = useState<StandardTransaction[]>(SAMPLE_TRANSACTIONS);
  const [evaluationReport, setEvaluationReport] = useState<CaseEvaluationReport | null>(null);

  const [currentStep, setCurrentStep] = useState<WorkflowStep>(0);
  const [completedSteps, setCompletedSteps] = useState<Set<WorkflowStep>>(new Set([0, 1, 2, 3, 4, 5]));

  // Auto evaluate initial sample on mount
  React.useEffect(() => {
    const { report, processedTransactions } = engine.evaluateCase(
      SAMPLE_CASE,
      SAMPLE_TRANSACTIONS,
      SAMPLE_ACCOUNTS
    );
    setEvaluationReport(report);
    setTransactions(processedTransactions);
  }, []);

  const handleResetToDemo = () => {
    setCaseMeta(SAMPLE_CASE);
    setAccounts(SAMPLE_ACCOUNTS);
    setTransactions(SAMPLE_TRANSACTIONS);
    const { report, processedTransactions } = engine.evaluateCase(
      SAMPLE_CASE,
      SAMPLE_TRANSACTIONS,
      SAMPLE_ACCOUNTS
    );
    setEvaluationReport(report);
    setTransactions(processedTransactions);
    setCurrentStep(4); // Jump straight to computation dashboard
    setCompletedSteps(new Set([0, 1, 2, 3, 4, 5]));
  };

  const handleNewCase = () => {
    const blankCase: CaseMetadata = {
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
    setCaseMeta(blankCase);
    setAccounts([]);
    setTransactions([]);
    setEvaluationReport(null);
    setCurrentStep(0);
    setCompletedSteps(new Set());
  };

  const markStepCompleted = (step: WorkflowStep) => {
    setCompletedSteps(prev => new Set([...prev, step]));
  };

  const goToStep = (step: WorkflowStep) => {
    setCurrentStep(step);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      <Header
        currentCase={caseMeta}
        onResetToDemo={handleResetToDemo}
        onNewCase={handleNewCase}
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
    </div>
  );
};

export default App;
