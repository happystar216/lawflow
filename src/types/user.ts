export interface User {
  id: string;
  email: string;
  name: string;
  firmName?: string; // 律所 / 公司名称
  role: 'LAWYER' | 'ASSISTANT' | 'JUDGE_ASSISTANT';
  createdAt: string;
  lastLoginAt: string;
}

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}
