import apiClient from './client';
import type { ApiResponse, TailscaleStatus } from '@oblihub/shared';

export interface PeerSuggestion {
  hostname: string;
  dnsName: string;
  ipv4: string | null;
  online: boolean;
  os: string | null;
  alreadyAttached: boolean;
}

export interface InstallCommandResult {
  command: string;
  subnetRoutes: string[];
  discoveryError?: string;
}

export interface ResolvedUpstream {
  host: string;
  port: number;
  scheme: string;
  via: 'local-docker-dns' | 'tailscale-subnet-route' | 'tailscale-hostname-published-port' | 'engine-public-host';
  hint: string;
}

export const tailscaleApi = {
  async status(): Promise<TailscaleStatus> {
    const res = await apiClient.get<ApiResponse<TailscaleStatus>>('/tailscale/status');
    return res.data.data!;
  },
  async peers(): Promise<PeerSuggestion[]> {
    const res = await apiClient.get<ApiResponse<PeerSuggestion[]>>('/tailscale/peers');
    return res.data.data!;
  },
  async installCommand(opts: {
    hostname: string;
    authKey?: string;
    subnetRoutes?: string[];
    acceptRoutes?: boolean;
    discoverFromEngineId?: number;
  }): Promise<InstallCommandResult> {
    const res = await apiClient.post<ApiResponse<InstallCommandResult>>('/tailscale/install-command', opts);
    return res.data.data!;
  },
  async resolveUpstream(containerId: number, port?: number): Promise<ResolvedUpstream> {
    const url = port
      ? `/tailscale/resolve-upstream/${containerId}?port=${port}`
      : `/tailscale/resolve-upstream/${containerId}`;
    const res = await apiClient.get<ApiResponse<ResolvedUpstream>>(url);
    return res.data.data!;
  },
};
