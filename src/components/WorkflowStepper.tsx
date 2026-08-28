import React from 'react';
import { 
  FolderPlus, 
  UploadCloud, 
  CheckCheck, 
  CalendarClock, 
  Cpu, 
  UserCheck, 
  FileCheck2 
} from 'lucide-react';

export type WorkflowStep = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface WorkflowStepperProps {
  currentStep: WorkflowStep;
  onSelectStep: (step: WorkflowStep) => void;
  completedSteps: Set<WorkflowStep>;
}

export const WorkflowStepper: React.FC<WorkflowStepperProps> = ({
  currentStep,
  onSelectStep,
  completedSteps
}) => {
  const steps = [
    { id: 0 as WorkflowStep, name: '案件建档', icon: FolderPlus, desc: '基础信息与标的' },
    { id: 1 as WorkflowStep, name: '证据上传', icon: UploadCloud, desc: '多源流水智能入库' },
    { id: 2 as WorkflowStep, name: '证据确认', icon: CheckCheck, desc: '平账审计与纠偏' },
    { id: 3 as WorkflowStep, name: '前置标注', icon: CalendarClock, desc: '时间轴与账户矩阵' },
    { id: 4 as WorkflowStep, name: '数据计算', icon: Cpu, desc: '11大算法引擎DAG' },
    { id: 5 as WorkflowStep, name: '后标注研判', icon: UserCheck, desc: '人物命名与证据勾选' },
    { id: 6 as WorkflowStep, name: '成果导出', icon: FileCheck2, desc: '法庭文书一键交付' },
  ];

  return (
    <div className="bg-white border-b border-slate-200 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
        <div className="flex items-center justify-between overflow-x-auto space-x-2 py-1 scrollbar-none">
          {steps.map((step, idx) => {
            const Icon = step.icon;
            const isCurrent = currentStep === step.id;
            const isCompleted = completedSteps.has(step.id);

            return (
              <button
                key={step.id}
                onClick={() => onSelectStep(step.id)}
                className={`flex items-center space-x-2.5 px-3.5 py-2 rounded-xl text-left transition-all flex-shrink-0 ${
                  isCurrent
                    ? 'bg-blue-50 text-blue-700 font-semibold ring-1 ring-blue-500/30 shadow-sm'
                    : isCompleted
                    ? 'text-slate-700 hover:bg-slate-100/80 font-medium'
                    : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50'
                }`}
              >
                <div
                  className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold transition-all ${
                    isCurrent
                      ? 'bg-blue-600 text-white shadow-md shadow-blue-500/20'
                      : isCompleted
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-slate-100 text-slate-400'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                </div>
                <div>
                  <div className="text-xs flex items-center space-x-1">
                    <span>{step.name}</span>
                    {isCompleted && !isCurrent && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                    )}
                  </div>
                  <div className="text-[10px] text-slate-400 font-normal truncate max-w-[90px]">
                    {step.desc}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
