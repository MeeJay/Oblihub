import apiClient from './client';
import type { ApiResponse, GpuInfo, StackPriority, YieldSignalSource } from '@oblihub/shared';

export interface GpuLiveStat {
  index: string;
  utilizationGpuPercent: number;
  utilizationMemoryPercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  powerDrawWatts: number;
  powerLimitWatts: number;
  temperatureCelsius: number | null;
  fanSpeedPercent: number | null;
}

export interface DashHost {
  cpuCount: number;
  ramBytes: number;
  ramGb: number;
  gpus: GpuInfo[];
  gpuLive: GpuLiveStat[];
  currentPowerLimits: Record<string, number>;
  platform: string;
  arch: string;
  cpuModel: string | null;
  cpuTemperatureCelsius: number | null;
}

export interface DashStack {
  id: number;
  name: string;
  composeProject: string | null;
  priority: StackPriority;
  state: 'running' | 'paused-by-watchdog' | 'stopped' | 'mixed';
  containerCount: number;
  runningContainerCount: number;
  cpuCapPercent: number | null;
  ramCapPercent: number | null;
  cpuShares: number | null;
  visibleGpuIds: string[] | null;
  yieldSignalSource: YieldSignalSource | null;
  yieldsToStackIds: number[] | null;
  yieldIdleTimeoutSeconds: number | null;
  isBusyNow: boolean | null;
  conso: {
    cpuPercentOfHost: number;
    cpuPercentOfCap: number | null;
    ramBytes: number;
    ramPercentOfHost: number;
    ramPercentOfCap: number | null;
  };
}

export interface ResourcesDashboardResponse {
  host: DashHost;
  stacks: DashStack[];
  activity: Record<number, number>;
}

export const resourcesApi = {
  async getResourcesDashboard(): Promise<ResourcesDashboardResponse> {
    const res = await apiClient.get<ApiResponse<ResourcesDashboardResponse>>('/resources/dashboard');
    return res.data.data!;
  },
  /** Host-wide power limit for a GPU. Returns the actually-applied wattage (nvidia-smi may
   *  clamp differently than requested in edge cases). */
  async setGpuPowerLimit(index: string, watts: number): Promise<{ index: string; watts: number }> {
    const res = await apiClient.put<ApiResponse<{ index: string; watts: number }>>(`/resources/gpus/${encodeURIComponent(index)}/power-limit`, { watts });
    return res.data.data!;
  },
};
