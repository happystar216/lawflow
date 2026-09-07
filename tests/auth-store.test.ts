import test from 'node:test';
import assert from 'node:assert/strict';
import { loginWithEmail, registerWithEmail } from '../src/store/authStore';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test('local profile passwords are hashed and there is no universal-password bypass', async () => {
  const previousStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
  try {
    await registerWithEmail('lawyer@example.com', 'a-strong-local-password', '测试律师');
    const stored = localStorage.getItem('LAWFLOW_REGISTERED_USERS_V1') || '';
    assert.doesNotMatch(stored, /a-strong-local-password/);
    assert.match(stored, /pbkdf2-sha256/);
    await assert.rejects(() => loginWithEmail('lawyer@example.com', 'xqzb'), /密码错误/);
    const user = await loginWithEmail('lawyer@example.com', 'a-strong-local-password');
    assert.equal(user.email, 'lawyer@example.com');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: previousStorage, configurable: true });
  }
});
