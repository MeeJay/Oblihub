import * as acme from 'acme-client';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { db } from '../db';
import { certificateService } from './proxy.service';
import { nginxService } from './nginx.service';
import { logger } from '../utils/logger';

// Queue for serializing cert requests (prevent parallel ACME conflicts)
const certQueue: Array<() => Promise<void>> = [];
let certProcessing = false;

async function processCertQueue(): Promise<void> {
  if (certProcessing) return;
  certProcessing = true;
  while (certQueue.length > 0) {
    const task = certQueue.shift()!;
    try { await task(); } catch (err) {
      logger.error({ err }, 'Cert queue task failed');
    }
  }
  certProcessing = false;
}

async function doRequestCertificate(certId: number, domains: string[], email: string): Promise<void> {
    try {
      await certificateService.updateStatus(certId, 'pending', undefined, null);

      // Create ACME client
      const accountKey = await acme.crypto.createPrivateKey();
      const client = new acme.Client({
        directoryUrl: acme.directory.letsencrypt.production,
        accountKey,
      });

      // Register account
      await client.createAccount({
        termsOfServiceAgreed: true,
        contact: [`mailto:${email}`],
      });

      // Create order
      const order = await client.createOrder({
        identifiers: domains.map(d => ({ type: 'dns', value: d })),
      });

      // Process authorizations (HTTP-01 challenge)
      const authorizations = await client.getAuthorizations(order);
      const acmeDir = nginxService.getAcmeDir();

      for (const auth of authorizations) {
        const challenge = auth.challenges.find((c: { type: string }) => c.type === 'http-01');
        if (!challenge) throw new Error(`No HTTP-01 challenge for ${auth.identifier.value}`);

        const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);

        // Write challenge file (world-readable for nginx user)
        const challengePath = path.join(acmeDir, challenge.token);
        fs.writeFileSync(challengePath, keyAuthorization, { mode: 0o644 });

        // Verify challenge
        await client.verifyChallenge(auth, challenge);
        await client.completeChallenge(challenge);
        await client.waitForValidStatus(challenge);

        // Clean up challenge file
        try { fs.unlinkSync(challengePath); } catch { /* ignore */ }
      }

      // Finalize order
      const [certKey, csr] = await acme.crypto.createCsr({
        commonName: domains[0],
        altNames: domains.length > 1 ? domains.slice(1) : undefined,
      });

      await client.finalizeOrder(order, csr);
      const cert = await client.getCertificate(order);

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

      await certificateService.updateStatus(certId, 'valid', {
        cert: certPaths.cert,
        key: certPaths.key,
        chain: certPaths.chain,
        expiresAt,
      }, null);

      logger.info({ certId, domains, primaryDomain }, 'Let\'s Encrypt certificate obtained');

      // Regenerate nginx configs to use new cert
      logger.info('Regenerating nginx configs after cert provisioning...');
      await nginxService.regenerateAndReload();
      logger.info('Nginx configs regenerated and reloaded after cert provisioning');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ certId, err }, 'Failed to obtain Let\'s Encrypt certificate');
      await certificateService.updateStatus(certId, 'error', undefined, msg);
      throw err;
    }
}

export const letsEncryptService = {
  /** Request a certificate from Let's Encrypt (queued to prevent parallel conflicts) */
  async requestCertificate(certId: number, domains: string[], email: string): Promise<void> {
    logger.info({ certId, domains }, 'Queueing certificate request');
    return new Promise<void>((resolve, reject) => {
      certQueue.push(async () => {
        try {
          await doRequestCertificate(certId, domains, email);
          resolve();
        } catch (err) { reject(err); }
      });
      processCertQueue();
    });
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
