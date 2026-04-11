import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db';
import { obligateService } from '../services/obligate.service';
import { appConfigService } from '../services/appConfig.service';
import { logger } from '../utils/logger';

const router = Router();

// GET /auth/callback?code=xxx&state=xxx
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code) { res.status(400).json({ success: false, error: 'Missing code' }); return; }

    const expectedState = req.session?.oauthState;
    if (!expectedState || !state || state !== expectedState) {
      logger.warn('Obligate callback: state mismatch');
      res.redirect('/login?error=sso_failed');
      return;
    }
    delete req.session.oauthState;

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${protocol}://${host}/auth/callback`;

    const assertion = await obligateService.exchangeCode(code, redirectUri);
    if (!assertion) { res.redirect('/login?error=sso_failed'); return; }

    // Find or create local user
    let localUserId: number;
    const existingLink = await db('sso_foreign_users')
      .where({ foreign_source: 'obligate', foreign_user_id: assertion.obligateUserId })
      .first() as { local_user_id: number } | undefined;

    if (existingLink) {
      localUserId = existingLink.local_user_id;
      await db('users').where({ id: localUserId }).update({
        role: assertion.role === 'admin' ? 'admin' : 'user',
        email: assertion.email,
        display_name: assertion.displayName,
        updated_at: new Date(),
      });
    } else {
      const [newUser] = await db('users').insert({
        username: `og_${assertion.username}`,
        display_name: assertion.displayName || assertion.username,
        email: assertion.email,
        role: assertion.role === 'admin' ? 'admin' : 'user',
        is_active: true,
        foreign_source: 'obligate',
        foreign_id: assertion.obligateUserId,
      }).returning('id') as Array<{ id: number }>;
      localUserId = newUser.id;
      await db('sso_foreign_users').insert({
        foreign_source: 'obligate',
        foreign_user_id: assertion.obligateUserId,
        local_user_id: localUserId,
      });
    }

    req.session.userId = localUserId;
    const user = await db('users').where({ id: localUserId }).first() as { username: string; role: string } | undefined;
    if (user) { req.session.username = user.username; req.session.role = user.role; }

    req.session.save((err) => {
      if (err) { res.redirect('/login?error=sso_failed'); return; }
      res.setHeader('Content-Type', 'text/html');
      res.end('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/"></head><body>Signing in...</body></html>');
    });
  } catch (err) {
    logger.error(err, 'Obligate callback error');
    res.redirect('/login?error=sso_failed');
  }
});

// GET /auth/sso-redirect
router.get('/sso-redirect', async (req, res) => {
  try {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) { res.redirect('/login'); return; }
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${protocol}://${host}/auth/callback`;
    const oauthState = crypto.randomBytes(32).toString('hex');
    req.session.oauthState = oauthState;
    const obligateUrl = `${raw.url}/authorize?client_id=${encodeURIComponent(raw.apiKey)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(oauthState)}`;
    req.session.save(() => { res.redirect(obligateUrl); });
  } catch { res.redirect('/login'); }
});

// GET /api/auth/sso-config
router.get('/sso-config', async (_req, res) => {
  try {
    const config = await obligateService.getSsoConfig();
    res.json({ success: true, data: config });
  } catch { res.json({ success: true, data: { obligateUrl: null, obligateReachable: false, obligateEnabled: false } }); }
});

/**
 * GET /api/auth/app-info
 * Called by Obligate (Bearer auth) to discover this app's structure.
 */
router.get('/app-info', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ success: false, error: 'Missing Bearer token' }); return; }
    const raw = await appConfigService.getObligateRaw();
    const receivedKey = authHeader.slice(7);
    logger.info({ hasStoredKey: !!raw.apiKey, storedKeyLen: raw.apiKey?.length, receivedKeyLen: receivedKey.length, match: receivedKey === raw.apiKey }, 'app-info auth check');
    if (!raw.apiKey || receivedKey !== raw.apiKey) { res.status(401).json({ success: false, error: 'Invalid API key' }); return; }
    // Return teams + roles in Obligate-compatible format
    const { teamService } = await import('../services/team.service');
    const { permissionService } = await import('../services/permission.service');
    const allTeams = await teamService.getAll();
    const allRoles = await permissionService.getAllRoles();
    const teams = allTeams.map(t => ({
      id: t.id,
      name: t.name,
      tenantSlug: 'default',
      tenantName: 'Default',
    }));
    res.json({
      success: true,
      data: {
        roles: allRoles.map(r => r.name),
        teams,
        tenants: [{ slug: 'default', name: 'Default' }],
      },
    });
  } catch (err) {
    logger.error(err, 'app-info error');
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

/**
 * GET /api/auth/dashboard-stats
 * Called by Obligate (Bearer auth) to show stats on the Obligate dashboard card.
 */
router.get('/dashboard-stats', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ success: false }); return; }
    const raw = await appConfigService.getObligateRaw();
    if (!raw.apiKey || authHeader.slice(7) !== raw.apiKey) { res.status(401).json({ success: false }); return; }

    const { stackService } = await import('../services/stack.service');
    const stacks = await stackService.getAll();

    let totalStacks = stacks.length;
    let upToDate = 0;
    let updateAvailable = 0;
    let totalContainers = 0;

    for (const s of stacks) {
      totalContainers += s.containers.length;
      const hasUpdate = s.containers.some(c => c.status === 'update_available');
      const hasError = s.containers.some(c => c.status === 'error');
      if (hasUpdate || hasError) updateAvailable++;
      else upToDate++;
    }

    res.json({ success: true, data: { stats: [
      { label: 'Stacks', value: totalStacks, color: '#58a6ff' },
      { label: 'Up to Date', value: upToDate, color: '#2ea043' },
      { label: 'Updates Available', value: updateAvailable, color: '#d29922' },
      { label: 'Containers', value: totalContainers, color: '#8b949e' },
    ] } });
  } catch { res.json({ success: true, data: null }); }
});

/**
 * GET /api/auth/sso-logout-url
 */
router.get('/sso-logout-url', async (req, res) => {
  try {
    const cfg = await appConfigService.getObligateRaw();
    if (!cfg.url) { res.json({ success: true, data: null }); return; }
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${protocol}://${host}/login`;
    const logoutUrl = `${cfg.url}/logout?redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.json({ success: true, data: logoutUrl });
  } catch { res.json({ success: true, data: null }); }
});

/**
 * GET /api/auth/connected-apps
 */
router.get('/connected-apps', async (req, res) => {
  try {
    if (!req.session?.userId) { res.status(401).json({ success: false }); return; }
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) { res.json({ success: true, data: [] }); return; }
    const r = await fetch(`${raw.url}/api/apps/connected`, { headers: { 'Authorization': `Bearer ${raw.apiKey}` } });
    if (!r.ok) { res.json({ success: true, data: [] }); return; }
    const data = await r.json() as { success: boolean; data?: unknown[] };
    res.json({ success: true, data: data.data ?? [] });
  } catch { res.json({ success: true, data: [] }); }
});

export default router;
