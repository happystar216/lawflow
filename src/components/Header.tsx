import React from 'react';
import { Scale, RefreshCw, FolderOpen } from 'lucide-react';
import { CaseMetadata } from '../types/case';
import { User } from '../types/user';
import { UserMenu } from './UserMenu';

interface HeaderProps {
  currentCase: CaseMetadata;
  currentUser: User | null;
  onNewCase: () => void;
  onOpenCaseManager: () => void;
  onLogout: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentCase,
  currentUser,
  onNewCase,
  onOpenCaseManager,
  onLogout
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
              <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                v3.1 分页复核版
              </span>
            </div>
            <p className="text-xs text-slate-400">执行律师银行流水智能穿透与取证系统</p>
          </div>
        </div>

        {/* Current Case Info Badge with Click to Switch */}
        <button
          onClick={onOpenCaseManager}
          className="hidden md:flex items-center bg-slate-800/80 hover:bg-slate-800 border border-slate-700/60 rounded-xl px-3.5 py-1.5 space-x-3 text-xs transition group"
          title="点击打开案件管理列表"
        >
          <FolderOpen className="w-4 h-4 text-blue-400 group-hover:scale-110 transition-transform" />
          <span className="text-slate-400">当前案件:</span>
          <span className="font-medium text-slate-200">{currentCase.caseNumber || '未命名案件'}</span>
          <span className="text-slate-600">|</span>
          <span className="text-slate-400">被执行人:</span>
          <span className="font-semibold text-amber-400">{currentCase.respondentName || '未指定'}</span>
        </button>

        {/* Actions */}
        <div className="flex items-center space-x-2">
          <button
            onClick={onOpenCaseManager}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 transition"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span>案件库</span>
          </button>

          <button
            onClick={onNewCase}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>新建案件</span>
          </button>

          {/* User Account Menu */}
          {currentUser && (
            <div className="pl-2 border-l border-slate-800">
              <UserMenu user={currentUser} onLogout={onLogout} />
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
