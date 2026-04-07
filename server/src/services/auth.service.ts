import { db } from '../db';
import { hashPassword, comparePassword } from '../utils/crypto';
import type { User } from '@oblihub/shared';

interface UserRow {
  id: number;
  username: string;
  password_hash: string | null;
  display_name: string | null;
  role: string;
  is_active: boolean;
  email: string | null;
  preferred_language: string;
  foreign_source: string | null;
  foreign_id: number | null;
  created_at: Date;
  updated_at: Date;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as User['role'],
    isActive: row.is_active,
    email: row.email,
    preferredLanguage: row.preferred_language ?? 'en',
    foreignSource: row.foreign_source,
    foreignId: row.foreign_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const authService = {
  async authenticate(username: string, password: string): Promise<User | null> {
    const row = await db<UserRow>('users').where({ username, is_active: true }).first();
    if (!row || !row.password_hash) return null;
    const valid = await comparePassword(password, row.password_hash);
    return valid ? rowToUser(row) : null;
  },

  async getUserById(id: number): Promise<User | null> {
    const row = await db<UserRow>('users').where({ id }).first();
    return row ? rowToUser(row) : null;
  },

  async ensureDefaultAdmin(username: string, password: string): Promise<void> {
    const existing = await db('users').where({ role: 'admin' }).first();
    if (existing) return;
    const passwordHash = await hashPassword(password);
    await db('users').insert({
      username,
      password_hash: passwordHash,
      role: 'admin',
      display_name: 'Administrator',
      is_active: true,
    });
  },
};
