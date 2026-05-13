import type { Request, Response, NextFunction } from 'express';
import { tailscaleService } from '../services/tailscale.service';
import { engineService } from '../services/engine.service';
import { stackService } from '../services/stack.service';
import { dockerService } from '../services/docker.service';

/**
 * Returns true if `ip` (IPv4 dotted quad) is inside `cidr` (e.g. "172.17.0.0/16"). Tiny
 * implementation — we only need IPv4 here and we control both sides of the input. Returns
 * false for malformed input rather than throwing, so the caller can fall through gracefully.
 */
function cidrContains(cidr: string, ip: string): boolean {
  const m = cidr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  const ipParts = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m || !ipParts) return false;
  const prefix = parseInt(m[5], 10);
  if (prefix < 0 || prefix > 32) return false;
  const toInt = (a: string, b: string, c: string, d: string): number =>
    (((parseInt(a, 10) << 24) >>> 0) + (parseInt(b, 10) << 16) + (parseInt(c, 10) << 8) + parseInt(d, 10)) >>> 0;
  const cidrInt = toInt(m[1], m[2], m[3], m[4]);
  const ipInt = toInt(ipParts[1], ipParts[2], ipParts[3], ipParts[4]);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (cidrInt & mask) === (ipInt & mask);
}

interface InstallCommandBody {
  hostname?: string;
  authKey?: string;
  subnetRoutes?: string[];
  acceptRoutes?: boolean;
  // When set, the server probes the target engine for its Docker bridge subnets and includes them
  // in --advertise-routes automatically. Convenient for the "Bridge routing" UI mode.
  discoverFromEngineId?: number;
}

export const tailscaleController = {
  /** Status of the local tailscaled (enabled? peers? self IP/hostname). Returns enabled:false
   *  gracefully when the sidecar isn't running — never throws. */
  async status(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const status = await tailscaleService.getStatus();
      res.json({ success: true, data: status });
    } catch (err) { next(err); }
  },

  async installCommand(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as InstallCommandBody;
      const hostname = (body.hostname || '').trim();
      if (!hostname) {
        res.status(400).json({ success: false, error: 'hostname is required' });
        return;
      }

      let subnetRoutes = body.subnetRoutes || [];
      if (body.discoverFromEngineId) {
        // Bridge-routing mode: query the remote daemon to list its bridge subnets, then advertise
        // them. We do this server-side so the operator doesn't have to ssh into the host to figure
        // it out — they already configured the engine, we already have a working client.
        try {
          const { dockerService } = await import('../services/docker.service');
          const client = await dockerService.forEngine(body.discoverFromEngineId);
          const networks = await client.listNetworks();
          const cidrs: string[] = [];
          for (const net of networks) {
            // Only bridge-driver networks have an interesting subnet — skip host/null/overlay.
            if (net.Driver !== 'bridge') continue;
            const ipam = (net as { IPAM?: { Config?: Array<{ Subnet?: string }> } }).IPAM;
            for (const cfg of ipam?.Config || []) {
              if (cfg.Subnet && !cidrs.includes(cfg.Subnet)) cidrs.push(cfg.Subnet);
            }
          }
          subnetRoutes = [...new Set([...subnetRoutes, ...cidrs])];
        } catch (err) {
          // Don't fail the whole request — just return the command without auto-discovered routes
          // and surface the reason so the user knows why nothing was prepopulated.
          res.json({
            success: true,
            data: {
              command: tailscaleService.generateInstallCommand({
                hostname,
                authKey: body.authKey,
                subnetRoutes,
                acceptRoutes: body.acceptRoutes,
              }),
              subnetRoutes,
              discoveryError: err instanceof Error ? err.message : String(err),
            },
          });
          return;
        }
      }

      const command = tailscaleService.generateInstallCommand({
        hostname,
        authKey: body.authKey,
        subnetRoutes,
        acceptRoutes: body.acceptRoutes,
      });
      res.json({ success: true, data: { command, subnetRoutes } });
    } catch (err) { next(err); }
  },

  /**
   * Returns the list of Tailnet peers in a shape ready to populate an autocomplete dropdown for
   * the Engine SSH form. Pre-filters offline peers? No — we keep all of them; the user might be
   * configuring an engine for a host that's currently offline.
   */
  /**
   * Compute the best `(host, port, scheme)` triple to use as the upstream for a proxy_host that
   * targets the given container. The UI calls this when the user picks a container in the proxy
   * host editor — it abstracts away the "is this on a remote engine + Tailscale + subnet routing?"
   * decision so the user doesn't have to.
   *
   * Resolution order (most specific → most general):
   *   1. Container has a published port AND its engine has tailscaleHostname → use
   *      `<tailscaleHostname>:<hostPort>`. Works without subnet routing.
   *   2. Container has an internal bridge IP AND its engine advertises a route covering that IP
   *      AND that route is approved on this node → use `<bridgeIP>:<containerPort>`. The "no
   *      published port needed" path.
   *   3. Container is local → use `<containerName>:<containerPort>` (Docker DNS).
   *   4. Engine has a public host → use `<engine.host>:<hostPort>` (last-resort fallback, requires
   *      the port to be published *and* reachable from the Oblihub server).
   *   5. None of the above → error with a clear remediation hint.
   *
   * The caller (UI) gets back `{ host, port, scheme }` plus a `via` tag explaining which path
   * was chosen so it can show the user *why* the upstream looks the way it does.
   */
  async resolveContainerUpstream(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const containerId = parseInt(req.params.containerId, 10);
      const preferredContainerPort = req.query.port ? parseInt(req.query.port as string, 10) : null;

      const container = await stackService.getContainerById(containerId);
      if (!container) {
        res.status(404).json({ success: false, error: 'Container not found' });
        return;
      }

      const ports = container.ports || [];
      // Pick the port: explicit query override > first published port > first container port
      const targetPort = preferredContainerPort
        ? ports.find((p) => p.containerPort === preferredContainerPort) || null
        : ports.find((p) => p.hostPort != null) || ports[0] || null;
      if (!targetPort) {
        res.status(400).json({
          success: false,
          error: 'Container exposes no ports — cannot resolve an upstream.',
        });
        return;
      }

      const engine = container.engineId ? await engineService.getById(container.engineId) : null;

      // Path 3: local engine, no published port needed → Docker DNS
      if (!engine || engine.type === 'local') {
        const host = container.containerName.replace(/^\//, '');
        res.json({
          success: true,
          data: {
            host,
            port: targetPort.containerPort,
            scheme: 'http',
            via: 'local-docker-dns',
            hint: `Resolves via Docker's embedded DNS — proxy and target are on the same engine.`,
          },
        });
        return;
      }

      // Path 2: subnet routing — needs the container's bridge IP + an approved route covering it.
      // We inspect the container to get its NetworkSettings.Networks[*].IPAddress.
      if (engine.tailscaleAdvertisedRoutes && engine.tailscaleHostname) {
        try {
          const client = await dockerService.forEngine(engine.id);
          const info = await client.getContainer(container.dockerId).inspect();
          const networks = info.NetworkSettings?.Networks || {};
          const bridgeIp = Object.values(networks)
            .map((n) => (n as { IPAddress?: string }).IPAddress)
            .find((ip): ip is string => !!ip);
          if (bridgeIp) {
            const status = await tailscaleService.getStatus();
            const matchingPeer = status.peers.find(
              (p) => p.dnsName === engine.tailscaleHostname || p.hostname === engine.tailscaleHostname
            );
            const routes = matchingPeer?.primaryRoutes || [];
            const covered = routes.some((cidr) => cidrContains(cidr, bridgeIp));
            if (covered) {
              res.json({
                success: true,
                data: {
                  host: bridgeIp,
                  port: targetPort.containerPort,
                  scheme: 'http',
                  via: 'tailscale-subnet-route',
                  hint: `Bridge IP routed via Tailscale subnet route on ${engine.tailscaleHostname}. No published port required.`,
                },
              });
              return;
            }
          }
        } catch (err) {
          // Fall through to path 1 / 4
          // (logging would clutter — the UI will see the eventual `via` tag and can act)
          void err;
        }
      }

      // Path 1: published port + Tailscale hostname
      if (engine.tailscaleHostname && targetPort.hostPort) {
        res.json({
          success: true,
          data: {
            host: engine.tailscaleHostname,
            port: targetPort.hostPort,
            scheme: 'http',
            via: 'tailscale-hostname-published-port',
            hint: `Uses the engine's Tailnet hostname + the container's published port. Works without subnet routing.`,
          },
        });
        return;
      }

      // Path 4: public host fallback
      if (engine.host && targetPort.hostPort) {
        res.json({
          success: true,
          data: {
            host: engine.host,
            port: targetPort.hostPort,
            scheme: 'http',
            via: 'engine-public-host',
            hint: `Falls back to the engine's public host. Requires the port to be reachable from the Oblihub server.`,
          },
        });
        return;
      }

      res.status(400).json({
        success: false,
        error:
          'Could not determine an upstream for this container. Either publish a port on the host, advertise the bridge subnet via Tailscale, or set a Tailscale hostname on the engine.',
      });
    } catch (err) { next(err); }
  },

  async peerSuggestions(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const status = await tailscaleService.getStatus();
      const engines = await engineService.getAll();
      const usedHostnames = new Set(
        engines.map((e) => e.tailscaleHostname).filter((h): h is string => !!h)
      );
      const suggestions = status.peers.map((p) => ({
        hostname: p.hostname,
        dnsName: p.dnsName,
        ipv4: p.ipv4,
        online: p.online,
        os: p.os,
        alreadyAttached: !!p.dnsName && usedHostnames.has(p.dnsName),
      }));
      res.json({ success: true, data: suggestions });
    } catch (err) { next(err); }
  },
};
