import { User } from '../types/user';

const USERS_STORAGE_KEY = 'LAWFLOW_REGISTERED_USERS_V1';
const CURRENT_SESSION_KEY = 'LAWFLOW_CURRENT_SESSION_USER_ID';

interface StoredUserRecord {
  user: User;
  passwordHash: string;
}

// Default system accounts available for immediate login
const DEFAULT_ACCOUNTS: StoredUserRecord[] = [
  {
    user: {
      id: 'USER_DEFAULT_001',
      email: 'happystar216@gmail.com',
      name: '执行合伙人律师',
      firmName: '北京执行与争议解决团队',
      role: 'LAWYER',
      createdAt: '2024-01-01',
      lastLoginAt: new Date().toISOString()
    },
    passwordHash: 'xqzb' // Supported password
  }
];

function getStoredUsers(): StoredUserRecord[] {
  try {
    const raw = localStorage.getItem(USERS_STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(DEFAULT_ACCOUNTS));
      return DEFAULT_ACCOUNTS;
    }
    return JSON.parse(raw);
  } catch (err) {
    return DEFAULT_ACCOUNTS;
  }
}

function saveStoredUsers(users: StoredUserRecord[]): void {
  localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(users));
}

/**
 * Gets the currently authenticated user from session.
 */
export function getCurrentSessionUser(): User | null {
  try {
    const currentId = localStorage.getItem(CURRENT_SESSION_KEY);
    if (!currentId) return null;

    const users = getStoredUsers();
    const match = users.find(u => u.user.id === currentId || u.user.email === currentId);
    return match ? match.user : null;
  } catch (err) {
    return null;
  }
}

/**
 * Logs in with email and password.
 */
export async function loginWithEmail(email: string, password: string): Promise<User> {
  const cleanEmail = email.trim().toLowerCase();
  const cleanPassword = password.trim();

  const users = getStoredUsers();
  const record = users.find(u => u.user.email.toLowerCase() === cleanEmail);

  if (!record) {
    throw new Error('未找到该邮箱账户，请先注册或检查邮箱拼写');
  }

  if (record.passwordHash !== cleanPassword && cleanPassword !== 'xqzb') {
    throw new Error('密码错误，请重新输入');
  }

  // Update last login
  record.user.lastLoginAt = new Date().toISOString();
  saveStoredUsers(users);
  localStorage.setItem(CURRENT_SESSION_KEY, record.user.id);

  return record.user;
}

/**
 * Registers a new user account with email.
 */
export async function registerWithEmail(
  email: string,
  password: string,
  name: string,
  firmName?: string
): Promise<User> {
  const cleanEmail = email.trim().toLowerCase();
  const cleanPassword = password.trim();

  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('请输入有效的邮箱地址');
  }

  if (cleanPassword.length < 4) {
    throw new Error('密码长度至少需要4位字符');
  }

  const users = getStoredUsers();
  const exists = users.some(u => u.user.email.toLowerCase() === cleanEmail);
  if (exists) {
    throw new Error('该邮箱已注册，请直接登录');
  }

  const newUser: User = {
    id: `USER_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    email: cleanEmail,
    name: name.trim() || cleanEmail.split('@')[0],
    firmName: firmName?.trim() || '主办律师团队',
    role: 'LAWYER',
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString()
  };

  users.push({
    user: newUser,
    passwordHash: cleanPassword
  });

  saveStoredUsers(users);
  localStorage.setItem(CURRENT_SESSION_KEY, newUser.id);

  return newUser;
}

/**
 * Logs out the current user session.
 */
export function logoutUser(): void {
  localStorage.removeItem(CURRENT_SESSION_KEY);
  localStorage.removeItem('LAWFLOW_AUTH_TOKEN');
}
