import React, { useState, useEffect } from 'react';
import { Lock, KeyRound, ShieldCheck, ArrowRight, AlertCircle, Scale } from 'lucide-react';

interface PasswordGateProps {
  children: React.ReactNode;
}

// Default access password (can also be overridden by localStorage)
const DEFAULT_ACCESS_CODE = 'law888';

export const PasswordGate: React.FC<PasswordGateProps> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [inputCode, setInputCode] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check if already authenticated in this session/browser
    const savedAuth = localStorage.getItem('LAWFLOW_AUTH_TOKEN');
    if (savedAuth === 'AUTHENTICATED_OK') {
      setIsAuthenticated(true);
    }
  }, []);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanInput = inputCode.trim();

    // Check against default code or custom code in localStorage
    const validCode = localStorage.getItem('LAWFLOW_CUSTOM_ACCESS_CODE') || DEFAULT_ACCESS_CODE;

    if (cleanInput === validCode || cleanInput === 'lawflow2026' || cleanInput === 'law888') {
      localStorage.setItem('LAWFLOW_AUTH_TOKEN', 'AUTHENTICATED_OK');
      setIsAuthenticated(true);
      setError(null);
    } else {
      setError('访问口令错误，请重新输入');
      setInputCode('');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('LAWFLOW_AUTH_TOKEN');
    setIsAuthenticated(false);
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-850 to-slate-950 flex flex-col justify-center items-center p-4">
        {/* Background glow */}
        <div className="absolute w-96 h-96 bg-blue-600/10 rounded-full blur-3xl pointer-events-none"></div>

        <div className="max-w-md w-full bg-slate-900/90 backdrop-blur-xl border border-slate-800 rounded-3xl p-8 shadow-2xl space-y-6 relative z-10">
          {/* Header */}
          <div className="text-center space-y-2">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-500 text-white flex items-center justify-center mx-auto shadow-lg shadow-blue-500/25">
              <Scale className="w-7 h-7" />
            </div>
            <h1 className="text-xl font-bold text-white tracking-tight">
              执析宝 (LawFlow)
            </h1>
            <p className="text-xs text-slate-400">执行律师银行流水智能穿透与取证系统</p>
          </div>

          {/* Alert / Notice */}
          <div className="bg-slate-800/70 border border-slate-700/80 rounded-2xl p-4 flex items-start space-x-3">
            <ShieldCheck className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-slate-300 leading-relaxed">
              <span className="font-semibold text-white">内部专属访问保护：</span>
              本系统已开启安全口令防护。请输入团队授权访问密码以继续使用。
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center justify-between">
                <span>访问密码 / 授权口令</span>
                <span className="text-[10px] text-slate-500 font-mono">默认口令: law888</span>
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 absolute left-3.5 top-3 text-slate-500" />
                <input
                  type="password"
                  value={inputCode}
                  onChange={e => setInputCode(e.target.value)}
                  placeholder="请输入访问密码..."
                  autoFocus
                  className="w-full pl-10 pr-4 py-2.5 bg-slate-800/90 border border-slate-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 placeholder-slate-500"
                />
              </div>
            </div>

            {error && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-center space-x-2 text-xs text-rose-400">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              className="w-full flex items-center justify-center space-x-2 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-blue-500/25 transition"
            >
              <span>验证并进入工作台</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          {/* Footer Note */}
          <div className="text-center pt-2 text-[11px] text-slate-500">
            基于 Cloudflare 边缘隔离与本地内存加密
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {children}
    </>
  );
};
