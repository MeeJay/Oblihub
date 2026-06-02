import * as acme from 'acme-client';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { db } from '../db';
import { certificateService } from './proxy.service';
import { nginxService } from './nginx.service';
import { logger } from '../utils/logger';

// Simple mutex for serializing cert requests
let certMutex: Promise<void> = Promise.resolve();

/**
 * Append a single entry to the certificate's per-request log + emit to pino. The DB write
 * is best-effort — a transient failure here must not interrupt the LE provisioning flow,
 * which is what the operator actually cares about.
 *
 * Reading/modifying request_log naively across multiple await points would race; we keep it
 * simple by reading the current array, appending, writing back — the LE flow is serialised
 * by the module-level mutex so no concurrent writes for the same cert.
 */
async function appendLog(certId: number, level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): Promise<void> {
  logger[level]({ certId, ...extra }, message);
  try {
    const row = await db('certificates').where({ id: certId }).select('request_log').first();
    let arr: Array<{ at: string; level: string; message: string }> = [];
    const raw = row?.request_log;
    if (Array.isArray(raw)) arr = raw as Array<{ at: string; level: string; message: string }>;
    else if (typeof raw === 'string' && raw) { try { arr = JSON.parse(raw); } catch { arr = []; } }
    arr.push({ at: new Date().toISOString(), level, message });
    // Cap at 500 entries so a runaway loop doesn't bloat the row.
    if (arr.length > 500) arr = arr.slice(-500);
    await db('certificates').where({ id: certId }).update({ request_log: JSON.stringify(arr) });
  } catch (err) {
    logger.warn({ certId, err }, 'Failed to append to certificate request_log');
  }
}

/** Clear the log at the start of a fresh attempt — keeps the UI focused on the current run. */
async function resetLog(certId: number): Promise<void> {
  try {
    await db('certificates').where({ id: certId }).update({ request_log: JSON.stringify([]) });
  } catch { /* non-fatal */ }
}

async function doRequestCertificate(certId: number, domains: string[], email: string): Promise<void> {
    try {
      await resetLog(certId);
      await appendLog(certId, 'info', `Starting Let's Encrypt certificate request for ${domains.join(', ')} (${email})`, { domains, email });
      await certificateService.updateStatus(certId, 'pending', undefined, null);

      // Create ACME client
      await appendLog(certId, 'info', 'Creating ACME client (Let\'s Encrypt production directory)');
      const accountKey = await acme.crypto.createPrivateKey();
      const client = new acme.Client({
        directoryUrl: acme.directory.letsencrypt.production,
        accountKey,
      });

      // Register account
      await appendLog(certId, 'info', `Registering ACME account (contact: ${email})`);
      await client.createAccount({
        termsOfServiceAgreed: true,
        contact: [`mailto:${email}`],
      });

      // Create order
      await appendLog(certId, 'info', `Creating order for: ${domains.join(', ')}`);
      const order = await client.createOrder({
        identifiers: domains.map(d => ({ type: 'dns', value: d })),
      });

      // Process authorizations (HTTP-01 challenge)
      await appendLog(certId, 'info', 'Fetching authorizations from ACME server');
      const authorizations = await client.getAuthorizations(order);
      const acmeDir = nginxService.getAcmeDir();

      for (const auth of authorizations) {
        const challenge = auth.challenges.find((c: { type: string }) => c.type === 'http-01');
        if (!challenge) throw new Error(`No HTTP-01 challenge for ${auth.identifier.value}`);

        await appendLog(certId, 'info', `[${auth.identifier.value}] Writing HTTP-01 challenge token (${challenge.token.slice(0, 12)}…) to ${acmeDir}`);
        const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);
        const challengePath = path.join(acmeDir, challenge.token);
        fs.writeFileSync(challengePath, keyAuthorization, { mode: 0o644 });

        try {
          // Self-test from inside the Oblihub server container — fetches the challenge URL
          // through the public DNS name. If THIS fails, LE definitely won't succeed either.
          // Helps distinguish "Oblihub serves nothing on port 80" from "internet can't reach us".
          const challengeUrl = `http://${auth.identifier.value}/.well-known/acme-challenge/${challenge.token}`;
          await appendLog(certId, 'info', `[${auth.identifier.value}] Local self-test: GET ${challengeUrl} from inside the Oblihub container`);
          try {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 15000);
            const r = await fetch(challengeUrl, { signal: ctrl.signal, redirect: 'manual' });
            clearTimeout(to);
            const body = await r.text();
            if (r.status === 200 && body.trim() === keyAuthorization.trim()) {
              await appendLog(certId, 'info', `[${auth.identifier.value}] Self-test passed ✓ (200, body matches)`);
            } else {
              await appendLog(certId, 'warn', `[${auth.identifier.value}] Self-test got HTTP ${r.status}${body ? `, body starts: ${body.slice(0, 80)}` : ''} — LE may also fail. Verify nginx serves /.well-known/acme-challenge/ for this hostname on port 80.`);
            }
          } catch (selfErr) {
            const sm = selfErr instanceof Error ? selfErr.message : String(selfErr);
            await appendLog(certId, 'warn', `[${auth.identifier.value}] Self-test failed (${sm}) — could be DNS not pointing here (split-horizon?), or port 80 not reachable from inside the container. Let's Encrypt will likely fail too.`);
          }

          await appendLog(certId, 'info', `[${auth.identifier.value}] Notifying Let's Encrypt that challenge is ready — they will fetch from the public internet now`);
          await client.verifyChallenge(auth, challenge);
          await client.completeChallenge(challenge);

          // Periodic heartbeat while waitForValidStatus polls so the operator doesn't think
          // the process froze. acme-client polls with backoff up to ~2 min before erroring.
          const start = Date.now();
          const tick = setInterval(() => {
            const elapsed = Math.round((Date.now() - start) / 1000);
            void appendLog(certId, 'info', `[${auth.identifier.value}] Waiting for Let's Encrypt validation… ${elapsed}s elapsed`);
          }, 10000);
          try {
            await client.waitForValidStatus(challenge);
          } finally {
            clearInterval(tick);
          }
          await appendLog(certId, 'info', `[${auth.identifier.value}] Challenge validated ✓`);
        } catch (chErr) {
          const chMsg = chErr instanceof Error ? chErr.message : String(chErr);
          await appendLog(certId, 'error', `[${auth.identifier.value}] Challenge failed: ${chMsg}`);
          await appendLog(certId, 'info', `Diagnostic checklist:`);
          await appendLog(certId, 'info', `  1. DNS — does ${auth.identifier.value} resolve to this server's public IP from the internet ?`);
          await appendLog(certId, 'info', `  2. Port 80 — is it open in your firewall + NAT/port-forward + ISP not blocking it ?`);
          await appendLog(certId, 'info', `  3. Cloudflare / CDN — if you proxy through Cloudflare (orange cloud), HTTP-01 challenges break. Switch to grey cloud (DNS-only) for the validation, OR use Cloudflare's full-strict mode with origin cert.`);
          await appendLog(certId, 'info', `  4. nginx — verify /etc/nginx/acme-challenge is served at /.well-known/acme-challenge/ for ${auth.identifier.value} on port 80 (no redirect to HTTPS for that path).`);
          throw chErr;
        } finally {
          try { fs.unlinkSync(challengePath); } catch { /* ignore */ }
        }
      }

      // Finalize order
      const [certKey, csr] = await acme.crypto.createCsr({
        commonName: domains[0],
        altNames: domains.length > 1 ? domains.slice(1) : undefined,
      });

      await appendLog(certId, 'info', 'All challenges validated — finalizing order');
      await client.finalizeOrder(order, csr);
      const cert = await client.getCertificate(order);
      await appendLog(certId, 'info', 'Certificate issued by Let\'s Encrypt');

      // Split cert and chain
      const certs = cert.split(/(?=-----BEGIN CERTIFICATE-----)/);
      const serverCert = certs[0];
      const chainCert = certs.slice(1).join('');

      // Write cert files named by primary domain
      const primaryDomain = domains[0];
      nginxService.writeCertFiles(primaryDomain, serverCert, certKey.toString(), chainCert);

      // Parse expiry
      const certPaths = nginxService.getCertPathsByDomain(primaryDomain);
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 90); // LE certs are 90 days

      await appendLog(certId, 'info', `Writing cert files to nginx (primary: ${primaryDomain}) — expires ${expiresAt.toISOString()}`);
      await certificateService.updateStatus(certId, 'valid', {
        cert: certPaths.cert,
        key: certPaths.key,
        chain: certPaths.chain,
        expiresAt,
      }, null);
      await appendLog(certId, 'info', 'Certificate installed ✓ Status: valid');

      // Regenerate nginx configs to use new cert (non-blocking)
      nginxService.regenerateAndReload().then(() => {
        logger.info({ certId }, 'Nginx reloaded after cert provisioning');
      }).catch(err => {
        logger.warn({ certId, err }, 'Nginx reload after cert provisioning failed (non-fatal)');
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      await appendLog(certId, 'error', `FAILED: ${msg}`);
      await certificateService.updateStatus(certId, 'error', undefined, msg);
      throw err;
    }
}

export const letsEncryptService = {
  /** Request a certificate from Let's Encrypt (serialized via mutex) */
  async requestCertificate(certId: number, domains: string[], email: string): Promise<void> {
    logger.info({ certId, domains }, 'Queueing certificate request');
    // Chain onto the mutex so requests run one at a time
    certMutex = certMutex.then(
      () => doRequestCertificate(certId, domains, email),
      () => doRequestCertificate(certId, domains, email), // even if previous failed, continue
    );
    return certMutex;
  },

  /** Upload a custom certificate */
  async uploadCustomCert(certId: number, certPem: string, keyPem: string, chainPem?: string): Promise<void> {
    try {
      // Get domain name from cert record
      const certRecord = await certificateService.getById(certId);
      const primaryDomain = certRecord?.domainNames?.[0] || `cert_${certId}`;
      nginxService.writeCertFiles(primaryDomain, certPem, keyPem, chainPem);

      // Try to parse expiry from cert
      let expiresAt: Date | undefined;
      try {
        const x509 = new crypto.X509Certificate(certPem);
        expiresAt = new Date(x509.validTo);
      } catch { /* ignore */ }

      const certPaths = nginxService.getCertPathsByDomain(primaryDomain);
      await certificateService.updateStatus(certId, 'valid', {
        cert: certPaths.cert,
        key: certPaths.key,
        chain: certPaths.chain,
        expiresAt,
      }, null);

      await nginxService.regenerateAndReload();
      logger.info({ certId }, 'Custom certificate uploaded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      await certificateService.updateStatus(certId, 'error', undefined, msg);
      throw err;
    }
  },

  /** Generate a self-signed certificate */
  async generateSelfSigned(certId: number, domains: string[]): Promise<void> {
    try {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      // Use openssl-like approach via acme-client crypto
      const [key, csr] = await acme.crypto.createCsr({
        commonName: domains[0],
        altNames: domains.length > 1 ? domains.slice(1) : undefined,
      });

      // For self-signed, we'll create a simple cert
      // In production you'd want proper x509 generation
      // For now, write a placeholder and mark as valid
      const certPaths = nginxService.getCertPathsByDomain(domains[0]);
      const expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);

      // Write key
      fs.writeFileSync(certPaths.key, key.toString());

      // For a real self-signed cert, we'd need node-forge or similar
      // Mark as pending for now - user should use LE or custom
      await certificateService.updateStatus(certId, 'pending', undefined, 'Self-signed certificates require manual upload. Use Let\'s Encrypt instead.');
      logger.info({ certId, domains }, 'Self-signed cert placeholder created');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      await certificateService.updateStatus(certId, 'error', undefined, msg);
    }
  },

  /** Check for certificates expiring within 30 days and auto-renew */
  async checkRenewals(): Promise<void> {
    try {
      const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const certs = await db('certificates')
        .where({ provider: 'letsencrypt', status: 'valid' })
        .whereNotNull('expires_at')
        .where('expires_at', '<', thirtyDaysFromNow);

      for (const cert of certs) {
        const domains = cert.domain_names as string[];
        const email = cert.acme_email as string;
        if (domains?.length && email) {
          logger.info({ certId: cert.id, domains, expiresAt: cert.expires_at }, 'Auto-renewing LE certificate');
          this.requestCertificate(cert.id, domains, email).catch(err => {
            logger.error({ certId: cert.id, err }, 'Auto-renewal failed');
          });
        }
      }
    } catch (err) {
      logger.error({ err }, 'Certificate renewal check failed');
    }
  },
};
