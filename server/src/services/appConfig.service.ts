import { db } from '../db';

export const appConfigService = {
  async get(key: string): Promise<string | null> {
    const row = await db('app_config').where({ key }).first() as { value: string | null } | undefined;
    return row?.value ?? null;
  },

  async set(key: string, value: string | null): Promise<void> {
    await db('app_config').insert({ key, value }).onConflict('key').merge({ value });
  },

  async getAll(): Promise<Record<string, string | null>> {
    const rows = await db('app_config').select('key', 'value') as Array<{ key: string; value: string | null }>;
    const result: Record<string, string | null> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  },

  async getObligateRaw(): Promise<{ url: string | null; apiKey: string | null; enabled: boolean }> {
    const url = await this.get('obligate_url');
    const apiKey = await this.get('obligate_api_key');
    const enabled = (await this.get('obligate_enabled')) === 'true';
    return { url, apiKey, enabled };
  },
};
