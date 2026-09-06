import apiClient from './client';
import type { ApiResponse } from '@oblihub/shared';

export type TrafficRange = '1h' | '6h' | '24h' | '7d' | '30d' | '90d';

export interface TrafficPoint {
  ts: string;
  reqCount: number;
  bytesOut: number;
  bytesIn: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  uniqueIps: number;
}

export interface TrafficSeries {
  bucket: 'minute' | 'hour';
  points: TrafficPoint[];
}

export interface TopIp {
  ip: string;
  reqCount: number;
  bytesOut: number;
  geo: {
    ip: string;
    countryCode: string | null;
    countryName: string | null;
    city: string | null;
    latitude: number | null;
    longitude: number | null;
    org: string | null;
  } | null;
}

export interface TopUri {
  uri: string;
  reqCount: number;
  avgLatencyMs: number;
}

export interface HostSummary {
  proxyHostId: number;
  domain: string;
  reqCount: number;
  bytesOut: number;
  errorCount: number;
}

export interface GeoCountry {
  code: string;
  name: string;
  reqCount: number;
  lat: number;
  lon: number;
  sampleIps: number;
}

export const trafficApi = {
  async hostTimeSeries(id: number, range: TrafficRange = '24h'): Promise<TrafficSeries> {
    const res = await apiClient.get<ApiResponse<TrafficSeries>>(`/traffic/proxy-host/${id}/timeseries?range=${range}`);
    return res.data.data!;
  },
  async hostTopIps(id: number, range: TrafficRange = '24h'): Promise<TopIp[]> {
    const res = await apiClient.get<ApiResponse<TopIp[]>>(`/traffic/proxy-host/${id}/top-ips?range=${range}`);
    return res.data.data!;
  },
  async hostTopUris(id: number, range: TrafficRange = '24h'): Promise<TopUri[]> {
    const res = await apiClient.get<ApiResponse<TopUri[]>>(`/traffic/proxy-host/${id}/top-uris?range=${range}`);
    return res.data.data!;
  },
  async summary(): Promise<HostSummary[]> {
    const res = await apiClient.get<ApiResponse<HostSummary[]>>('/traffic/summary');
    return res.data.data!;
  },
  async teamCumul(range: TrafficRange = '24h'): Promise<TrafficSeries> {
    const res = await apiClient.get<ApiResponse<TrafficSeries>>(`/traffic/team-cumul?range=${range}`);
    return res.data.data!;
  },
  async geo(range: TrafficRange = '24h'): Promise<GeoCountry[]> {
    const res = await apiClient.get<ApiResponse<GeoCountry[]>>(`/traffic/geo?range=${range}`);
    return res.data.data!;
  },
};
