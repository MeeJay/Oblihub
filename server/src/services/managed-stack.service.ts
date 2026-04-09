import { db } from '../db';
import type { ManagedStack, ManagedStackStatus } from '@oblihub/shared';

function toCamelCase(row: Record<string, unknown>): ManagedStack {
  return {
    id: row.id as number,
    name: row.name as string,
    composeContent: row.compose_content as string,
    envContent: (row.env_content as string) || null,
    status: row.status as ManagedStackStatus,
    composeProject: row.compose_project as string,
    errorMessage: (row.error_message as string) || null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export const managedStackService = {
  async getAll(): Promise<ManagedStack[]> {
    const rows = await db('managed_stacks').orderBy('name');
    return rows.map(toCamelCase);
  },

  async getById(id: number): Promise<ManagedStack | null> {
    const row = await db('managed_stacks').where({ id }).first();
    return row ? toCamelCase(row) : null;
  },

  async create(data: { name: string; composeContent: string; envContent?: string | null }): Promise<ManagedStack> {
    const projectName = data.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const [row] = await db('managed_stacks').insert({
      name: data.name,
      compose_content: data.composeContent,
      env_content: data.envContent || null,
      status: 'draft',
      compose_project: projectName,
    }).returning('*');
    return toCamelCase(row);
  },

  async update(id: number, data: { name?: string; composeContent?: string; envContent?: string | null }): Promise<ManagedStack | null> {
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) {
      updates.name = data.name;
      updates.compose_project = data.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    }
    if (data.composeContent !== undefined) updates.compose_content = data.composeContent;
    if (data.envContent !== undefined) updates.env_content = data.envContent;
    const [row] = await db('managed_stacks').where({ id }).update(updates).returning('*');
    return row ? toCamelCase(row) : null;
  },

  async setStatus(id: number, status: ManagedStackStatus, errorMessage: string | null = null): Promise<void> {
    await db('managed_stacks').where({ id }).update({
      status,
      error_message: errorMessage,
      updated_at: new Date(),
    });
  },

  async delete(id: number): Promise<boolean> {
    const count = await db('managed_stacks').where({ id }).delete();
    return count > 0;
  },
};
