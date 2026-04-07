import { appConfigService } from './appConfig.service';
import { logger } from '../utils/logger';

interface ObligateAssertion {
  obligateUserId: number;
  username: string;
  email: string | null;
  displayName: string | null;
  role: string;
  tenants: Array<{ slug: string; role: string }>;
  teams: string[];
  linkedLocalUserId: number | null;
  preferences?: Record<string, unknown>;
}

export const obligateService = {
  async getSsoConfig(): Promise<{ obligateUrl: string | null; obligateReachable: boolean; obligateEnabled: boolean }> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.enabled) {
      return { obligateUrl: null, obligateReachable: false, obligateEnabled: false };
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${raw.url}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      return { obligateUrl: raw.url, obligateReachable: res.ok, obligateEnabled: true };
    } catch {
      return { obligateUrl: raw.url, obligateReachable: false, obligateEnabled: true };
    }
  },

  async exchangeCode(code: string, redirectUri: string): Promise<ObligateAssertion | null> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return null;
    try {
      const res = await fetch(`${raw.url}/api/oauth/token/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${raw.apiKey}` },
        body: JSON.stringify({ code, redirect_uri: redirectUri }),
      });
      if (!res.ok) return null;
      const data = await res.json() as { success: boolean; data?: ObligateAssertion };
      return data.success ? (data.data ?? null) : null;
    } catch (err) {
      logger.error(err, 'Obligate code exchange failed');
      return null;
    }
  },
};
