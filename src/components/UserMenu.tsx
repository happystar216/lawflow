import React, { useState, useRef, useEffect } from 'react';
import { User as UserType } from '../types/user';
import { User, LogOut, Building, ShieldCheck, ChevronDown } from 'lucide-react';

interface UserMenuProps {
  user: UserType;
  onLogout: () => void;
}

export const UserMenu: React.FC<UserMenuProps> = ({ user, onLogout }) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const initial = user.name ? user.name.slice(0, 1).toUpperCase() : user.email.slice(0, 1).toUpperCase();

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center space-x-2 pl-2 pr-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700/80 border border-slate-700/60 text-xs transition"
      >
        <div className="w-6 h-6 rounded-lg bg-gradient-to-tr from-blue-600 to-indigo-500 text-white font-bold text-xs flex items-center justify-center shadow-sm">
          {initial}
        </div>
        <span className="font-medium text-slate-200 hidden sm:inline max-w-[120px] truncate">
          {user.name || user.email.split('@')[0]}
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-2 z-50 animate-in fade-in zoom-in-95 duration-100">
          <div className="p-3 border-b border-slate-800 space-y-1">
            <div className="font-bold text-xs text-white flex items-center justify-between">
              <span>{user.name}</span>
              <span className="text-[10px] font-normal px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">
                主办律师
              </span>
            </div>
            <div className="text-[11px] text-slate-400 font-mono truncate">{user.email}</div>
            {user.firmName && (
              <div className="text-[11px] text-slate-400 flex items-center space-x-1 pt-1">
                <Building className="w-3 h-3 text-slate-500" />
                <span className="truncate">{user.firmName}</span>
              </div>
            )}
          </div>

          <div className="p-1">
            <button
              onClick={() => {
                setIsOpen(false);
                onLogout();
              }}
              className="w-full flex items-center space-x-2 px-3 py-2 rounded-xl text-xs font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 transition"
            >
              <LogOut className="w-4 h-4" />
              <span>退出登录 / 切换账号</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
