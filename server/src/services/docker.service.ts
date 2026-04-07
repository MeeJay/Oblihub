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
