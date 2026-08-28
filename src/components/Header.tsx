import React from 'react';
import { Scale, Cloud, Sparkles, RefreshCw, GitBranch, Lock } from 'lucide-react';
import { CaseMetadata } from '../types/case';

interface HeaderProps {
  currentCase: CaseMetadata;
  onResetToDemo: () => void;
  onNewCase: () => void;
  onLock?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentCase,
  onResetToDemo,
  onNewCase,
  onLock
}) => {
  return (
    <header className="bg-slate-900 border-b border-slate-800 text-white sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Scale className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-bold text-lg tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-slate-100 to-slate-300">
                执析宝 (LawFlow)
              </span>
              <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">
                CF Serverless
              </span>
            </div>
            <p className="text-xs text-slate-400">执行律师银行流水智能穿透与取证系统</p>
          </div>
        </div>

        {/* Current Case Info Badge */}
        <div className="hidden md:flex items-center bg-slate-800/80 border border-slate-700/60 rounded-lg px-3 py-1.5 space-x-3 text-xs">
          <span className="text-slate-400">当前案件:</span>
          <span className="font-medium text-slate-200">{currentCase.caseNumber || '未命名案件'}</span>
          <span className="text-slate-600">|</span>
          <span className="text-slate-400">被执行人:</span>
          <span className="font-semibold text-amber-400">{currentCase.respondentName || '未指定'}</span>
        </div>

        {/* Actions */}
        <div className="flex items-center space-x-2">
          <button
            onClick={onResetToDemo}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 transition"
            title="一键载入胡艳红典型执行流水示范案"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>示范案</span>
          </button>

          <button
            onClick={onNewCase}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>新建</span>
          </button>

          {onLock && (
            <button
              onClick={onLock}
              className="p-2 rounded-lg text-slate-400 hover:text-amber-400 hover:bg-slate-800 transition"
              title="锁定并退出登录"
            >
              <Lock className="w-4 h-4" />
            </button>
          )}

          <a
            href="https://github.com/happystar216/lawflow"
            target="_blank"
            rel="noreferrer"
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition flex items-center space-x-1"
            title="GitHub 源码仓库"
          >
            <GitBranch className="w-4 h-4" />
          </a>

          <div className="flex items-center space-x-1 pl-2 border-l border-slate-800 text-xs text-emerald-400">
            <Cloud className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">CF Edge Ready</span>
          </div>
        </div>
      </div>
    </header>
  );
};
