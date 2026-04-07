import Docker from 'dockerode';
import { config } from '../config';
import { logger } from '../utils/logger';

let dockerInstance: Docker | null = null;

function getDocker(): Docker {
  if (!dockerInstance) {
    dockerInstance = new Docker({ socketPath: config.dockerSocket });
  }
  return dockerInstance;
}

export interface DiscoveredContainer {
  dockerId: string;
  containerName: string;
  image: string;
  imageTag: string;
  composeProject: string | null;
  composeService: string | null;
  state: string;
  labels: Record<string, string>;
}

export const dockerService = {
  /** List all running containers, extracting compose project info */
  async listContainers(): Promise<DiscoveredContainer[]> {
    const docker = getDocker();
    const containers = await docker.listContainers({ all: false });
    return containers.map((c) => {
      const labels = c.Labels || {};
      // Parse image:tag — handle registry/namespace/repo:tag
      const fullImage = c.Image || '';
      let image = fullImage;
      let imageTag = 'latest';
      const lastColon = fullImage.lastIndexOf(':');
      // Check if the colon is part of a tag (not a port in registry URL)
      if (lastColon > 0 && !fullImage.substring(lastColon).includes('/')) {
        image = fullImage.substring(0, lastColon);
        imageTag = fullImage.substring(lastColon + 1);
      }

      return {
        dockerId: c.Id.substring(0, 12),
        containerName: (c.Names?.[0] || '').replace(/^\//, ''),
        image,
        imageTag,
        composeProject: labels['com.docker.compose.project'] || null,
        composeService: labels['com.docker.compose.service'] || null,
        state: c.State || 'unknown',
        labels,
      };
    });
  },

  /** Get the local image digest (RepoDigests) */
  async getLocalDigest(imageName: string): Promise<string | null> {
    try {
      const docker = getDocker();
      const imageInfo = await docker.getImage(imageName).inspect();
      const digests = imageInfo.RepoDigests || [];
      if (digests.length === 0) return null;
      // RepoDigests format: "registry/repo@sha256:abc..."
      const first = digests[0];
      const atIdx = first.indexOf('@');
      return atIdx >= 0 ? first.substring(atIdx + 1) : null;
    } catch (err) {
      logger.warn({ imageName, err }, 'Failed to get local digest');
      return null;
    }
  },

  /** Pull a new image */
  async pullImage(imageName: string, tag: string = 'latest'): Promise<void> {
    const docker = getDocker();
    const fullRef = `${imageName}:${tag}`;
    logger.info({ fullRef }, 'Pulling image...');

    return new Promise((resolve, reject) => {
      docker.pull(fullRef, {}, (err: Error | null, stream?: NodeJS.ReadableStream) => {
        if (err || !stream) return reject(err || new Error('No stream'));
        // Follow the pull progress stream to completion
        docker.modem.followProgress(stream, (err2: Error | null) => {
          if (err2) return reject(err2);
          logger.info({ fullRef }, 'Image pulled successfully');
          resolve();
        });
      });
    });
  },

  /** Inspect a container to capture its full config for recreation */
  async inspectContainer(dockerId: string): Promise<Docker.ContainerInspectInfo> {
    const docker = getDocker();
    const container = docker.getContainer(dockerId);
    return container.inspect();
  },

  /**
   * Recreate a container with a new image, preserving all config.
   * Steps: inspect → stop → remove → create (same config, new image) → start
   * Returns the new container ID.
   */
  async recreateContainer(dockerId: string, newImage: string, newTag: string): Promise<string> {
    const docker = getDocker();
    const container = docker.getContainer(dockerId);

    // 1. Capture full config
    const info = await container.inspect();
    const oldName = info.Name.replace(/^\//, '');

    logger.info({ dockerId, oldName, newImage: `${newImage}:${newTag}` }, 'Recreating container...');

    // 2. Stop
    try {
      await container.stop({ t: 10 });
    } catch (err: unknown) {
      // Container might already be stopped
      if (!(err instanceof Error && err.message?.includes('not running'))) throw err;
    }

    // 3. Remove
    await container.remove({ force: true });

    // 4. Build create options from inspect data
    const createOpts: Docker.ContainerCreateOptions = {
      name: oldName,
      Image: `${newImage}:${newTag}`,
      Cmd: info.Config.Cmd || undefined,
      Entrypoint: info.Config.Entrypoint || undefined,
      Env: info.Config.Env || [],
      Labels: info.Config.Labels || {},
      ExposedPorts: info.Config.ExposedPorts || {},
      WorkingDir: info.Config.WorkingDir || undefined,
      User: info.Config.User || undefined,
      Hostname: info.Config.Hostname || undefined,
      Domainname: info.Config.Domainname || undefined,
      Tty: info.Config.Tty || false,
      OpenStdin: info.Config.OpenStdin || false,
      StdinOnce: info.Config.StdinOnce || false,
      HostConfig: info.HostConfig as Docker.HostConfig,
      NetworkingConfig: undefined as unknown as Record<string, unknown>,
    };

    // 5. Rebuild network config from inspect data
    const networks = info.NetworkSettings?.Networks;
    if (networks && Object.keys(networks).length > 0) {
      const endpointsConfig: Record<string, Docker.EndpointSettings> = {};
      // Only attach to the first network at creation time.
      // Additional networks must be connected after creation.
      const networkNames = Object.keys(networks);
      const primaryNet = networkNames[0];
      const primaryConfig = networks[primaryNet];
      endpointsConfig[primaryNet] = {
        Aliases: primaryConfig.Aliases || [],
        IPAMConfig: primaryConfig.IPAMConfig || undefined,
      } as Docker.EndpointSettings;

      createOpts.NetworkingConfig = { EndpointsConfig: endpointsConfig };

      // Store additional networks for post-creation connection
      const additionalNetworks = networkNames.slice(1).map(name => ({
        name,
        config: networks[name],
      }));

      // 6. Create container
      const newContainer = await docker.createContainer(createOpts);
      const newId = newContainer.id.substring(0, 12);

      // 7. Connect additional networks before starting
      for (const net of additionalNetworks) {
        try {
          const network = docker.getNetwork(net.name);
          await network.connect({
            Container: newContainer.id,
            EndpointConfig: {
              Aliases: net.config.Aliases || [],
              IPAMConfig: net.config.IPAMConfig || undefined,
            } as Docker.EndpointSettings,
          });
        } catch (err) {
          logger.warn({ network: net.name, newId }, 'Failed to connect additional network');
        }
      }

      // 8. Start
      await newContainer.start();
      logger.info({ oldId: dockerId, newId, name: oldName }, 'Container recreated successfully');
      return newId;
    }

    // No networks — simple create + start
    const newContainer = await docker.createContainer(createOpts);
    await newContainer.start();
    const newId = newContainer.id.substring(0, 12);
    logger.info({ oldId: dockerId, newId, name: oldName }, 'Container recreated successfully');
    return newId;
  },

  /** Restart a container (stop + start) */
  async restartContainer(dockerId: string): Promise<void> {
    const docker = getDocker();
    const container = docker.getContainer(dockerId);
    logger.info({ dockerId }, 'Restarting container...');
    await container.restart();
    logger.info({ dockerId }, 'Container restarted');
  },

  /**
   * Clean up old renamed containers left over from a self-update.
   * Called on startup. Finds containers whose name contains "-old-" and removes them.
   */
  async cleanupOldSelfContainers(): Promise<void> {
    try {
      const docker = getDocker();
      const containers = await docker.listContainers({ all: true });
      for (const c of containers) {
        const name = (c.Names?.[0] || '').replace(/^\//, '');
        if (name.match(/-old-\d+$/)) {
          logger.info({ name, id: c.Id.substring(0, 12), state: c.State }, 'Cleaning up old self-update container');
          const container = docker.getContainer(c.Id);
          try {
            if (c.State === 'running') await container.stop({ t: 5 });
          } catch { /* already stopped */ }
          await container.remove({ force: true });
          logger.info({ name }, 'Old container removed');
        }
      }
    } catch (err) {
      logger.warn(err, 'Failed to clean up old self-update containers');
    }
  },

  /** Check if Docker socket is accessible */
  async ping(): Promise<boolean> {
    try {
      const docker = getDocker();
      await docker.ping();
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Get our own container ID by reading /proc/self/cgroup or HOSTNAME env.
   * Returns null if not running in Docker.
   */
  getSelfContainerId(): string | null {
    // Docker sets HOSTNAME to the container ID (first 12 chars)
    const hostname = process.env.HOSTNAME;
    if (hostname && /^[a-f0-9]{12,}$/.test(hostname)) {
      return hostname.substring(0, 12);
    }
    // Fallback: read from cgroup
    try {
      const fs = require('fs');
      const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8') as string;
      const match = cgroup.match(/docker[/-]([a-f0-9]{12,64})/);
      if (match) return match[1].substring(0, 12);
    } catch { /* not in Docker */ }
    return null;
  },

  /**
   * Self-update: pull new image, then use a helper container with docker CLI
   * to run `docker compose up -d` on the host. This preserves compose networking.
   *
   * Strategy: spawn a short-lived `docker/cli` container that mounts the Docker
   * socket and the compose project dir, then runs `docker compose up -d --no-deps <service>`.
   * This container outlives us (our container gets recreated by compose).
   */
  async selfUpdate(newImage: string, newTag: string): Promise<void> {
    const selfId = this.getSelfContainerId();
    if (!selfId) throw new Error('Cannot determine own container ID — not running in Docker?');

    const docker = getDocker();
    const self = docker.getContainer(selfId);
    const info = await self.inspect();
    const labels = info.Config.Labels || {};
    const composeProject = labels['com.docker.compose.project'] || null;
    const composeWorkdir = labels['com.docker.compose.project.working_dir'] || null;
    const composeService = labels['com.docker.compose.service'] || 'server';

    logger.info({ selfId, composeProject, composeService, newImage: `${newImage}:${newTag}` }, 'Self-update: starting...');

    // 1. Pull the new image (while we're still running)
    await this.pullImage(newImage, newTag);
    logger.info('Self-update: image pulled');

    if (!composeProject || !composeWorkdir) {
      throw new Error('Self-update requires a Docker Compose project. Update manually with: docker compose pull && docker compose up -d');
    }

    // 2. Spawn a helper container that runs docker compose up -d
    // The helper mounts the Docker socket and the compose project dir,
    // runs the compose command, then exits. Because it's a separate container,
    // it survives the recreation of our own container.
    const helperImage = 'docker:cli';

    // Ensure the helper image is available
    try {
      await docker.getImage(helperImage).inspect();
    } catch {
      logger.info('Self-update: pulling docker:cli helper image...');
      await this.pullImage('docker', 'cli');
    }

    const helperContainer = await docker.createContainer({
      Image: helperImage,
      Cmd: ['sh', '-c', `sleep 2 && docker compose -p ${composeProject} up -d --no-deps ${composeService}`],
      HostConfig: {
        Binds: [
          '/var/run/docker.sock:/var/run/docker.sock',
          `${composeWorkdir}:${composeWorkdir}`,
        ],
        AutoRemove: true,
      } as Docker.HostConfig,
      WorkingDir: composeWorkdir,
    });

    await helperContainer.start();
    logger.info('Self-update: helper container started, will recreate us via compose. Exiting...');

    // 3. Exit — the helper container will docker compose up -d us with proper networking
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  },

  /** Get Docker engine version info */
  async getVersion(): Promise<{ version: string; apiVersion: string } | null> {
    try {
      const docker = getDocker();
      const info = await docker.version();
      return { version: info.Version, apiVersion: info.ApiVersion };
    } catch {
      return null;
    }
  },
};
