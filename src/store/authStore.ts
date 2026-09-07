import { User } from '../types/user';

const USERS_STORAGE_KEY = 'LAWFLOW_REGISTERED_USERS_V1';
const CURRENT_SESSION_KEY = 'LAWFLOW_CURRENT_SESSION_USER_ID';

interface StoredUserRecord {
  user: User;
  passwordHash: string;
}

const DEFAULT_ACCOUNTS: StoredUserRecord[] = [];
const HASH_PREFIX = 'pbkdf2-sha256';
const HASH_ITERATIONS = 210_000;

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

  if (!(await verifyPassword(cleanPassword, record.passwordHash))) {
    throw new Error('密码错误，请重新输入');
  }

  // Migrate legacy plaintext local records only after the user proves knowledge of the password.
  if (!record.passwordHash.startsWith(`${HASH_PREFIX}$`)) {
    record.passwordHash = await hashPassword(cleanPassword);
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

  if (cleanPassword.length < 10) {
    throw new Error('密码长度至少需要10位字符');
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
    passwordHash: await hashPassword(cleanPassword)
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

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derivePassword(password, salt);
  return `${HASH_PREFIX}$${HASH_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(derived)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith(`${HASH_PREFIX}$`)) return stored === password;
  const [, iterationsText, saltText, expectedText] = stored.split('$');
  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < 100_000 || !saltText || !expectedText) return false;
  const actual = await derivePassword(password, base64ToBytes(saltText), iterations);
  const expected = base64ToBytes(expectedText);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
}

async function derivePassword(password: string, salt: Uint8Array, iterations = HASH_ITERATIONS): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const saltBuffer = Uint8Array.from(salt).buffer;
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBuffer, iterations }, key, 256);
  return new Uint8Array(bits);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
