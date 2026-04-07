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

export default router;
