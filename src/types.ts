export { POWER_OFF_ACTIONS, REBOOT_ACTIONS, HIBERNATE_ACTIONS } from './powerActions';

export interface Profile {
  id: number;
  name: string;
  username: string;
  auth_type: 'password' | 'key';
  // passwords and keys are not returned by API for security, except via setup.
}

export interface Group {
  id: number;
  name: string;
  icon: string;
  color: string;
  position: number;
}

export interface Device {
  id: number;
  name: string;
  ip: string;
  mac: string;
  hostname?: string | null;
  type: string;
  profile_id: number | null;
  broadcast_address: string | null;
  active: number;
  base_power_w?: number | null;
  interfaces?: DeviceInterface[] | null;
  has_agent_token?: number;
  last_seen?: number | null;
  agent_version?: string | null;
  os_family?: 'linux' | 'macos' | null;
  os_name?: string | null;
  group_id?: number | null;
  position?: number | null;
  poweroff_action?: string | null;
  reboot_action?: string | null;
  hibernate_action?: string | null;
  disable_power?: number;
  disable_ping?: number;
  disable_terminal?: number;
  disable_agent_update?: number;
}

export interface PendingDeviceAction {
  action: 'reboot' | 'shutdown' | 'hibernate' | 'update';
  status: 'pending' | 'acknowledged' | 'started' | 'failed';
  created_at: number;
  output?: string | null;
}

export interface DeviceInterface {
  name: string;
  mac: string | null;
  kind: 'eth' | 'wifi' | null;
  ips: string[];
  broadcast: string | null;
}

export interface GpuProcess {
  pid: number;
  name: string;
  mem_mb: number;
}

export interface GpuMetrics {
  util: number | null;
  mem_used_mb: number;
  mem_total_mb: number;
  temp_c: number | null;
  power_w: number | null;
  name?: string | null;
  processes: GpuProcess[];
}

export interface AgentSnapshot {
  hostname: string | null;
  cpu: number | null;
  load: [number, number, number];
  mem_total: number;
  mem_used: number;
  swap_total: number;
  swap_used: number;
  disks: { name: string; total: number; used: number }[];
  net_rx: number;
  net_tx: number;
  uptime_s: number | null;
  gpus: GpuMetrics[];
  cpu_power_w: number | null;
  power_total_w: number | null;
  interfaces?: DeviceInterface[];
  agent_version?: string | null;
  interval?: number | null;
  ts: number;
  os_family?: 'linux' | 'macos' | null;
  os_name?: string | null;
  os_id?: string | null;
  kernel?: string | null;
  cpu_vendor?: string | null;
  cpu_model?: string | null;
  cpu_cores?: number | null;
  cpu_freq_ghz?: number | null;
}

export interface DeviceLiveStats {
  live: AgentSnapshot | null;
  last_seen: number | null;
}

export interface HistoryPoint {
  ts: number;
  cpu_avg: number | null;
  cpu_max: number | null;
  mem_avg: number | null;
  mem_max: number | null;
  gpu_avg: number | null;
  gpu_max: number | null;
  power_avg: number | null;
  power_max: number | null;
  net_rx_avg: number | null;
  net_tx_avg: number | null;
}

export type HistoryRange = '1h' | '6h' | '24h' | '7d' | '30d' | '1y';

export interface AppSettings {
  cost_per_kwh: number | null;
  currency: string;
  agent_interval_seconds?: number;
  ui_refresh_seconds?: number;
  dashboard_view?: DashboardView;
  dashboard_card_size?: CardSize;
  poweroff_action: string;
  reboot_action: string;
  hibernate_action: string;
}

export type DashboardView = 'grid' | 'list';

export type CardSize = 'normal' | 'compact' | 'minimal';

export type Theme = 'dark' | 'light' | 'terminal' | 'monokai';

export type EnergyRange = '1h' | '24h' | '30d';

export interface EnergyComponent {
  key: string;
  label: string;
  avg_w: number | null;
  kwh: number;
}

export interface EnergyStats {
  range: string;
  kwh: number;
  cost: number | null;
  currency: string;
  base_power_w?: number | null;
  base_kwh?: number;
  components?: EnergyComponent[];
}

export interface FleetPowerPoint {
  ts: number;
  power_w: number;
}

export interface FleetPowerStats {
  range: string;
  points: FleetPowerPoint[];
}

export type ApiOperation = 'status' | 'start' | 'stop' | 'restart';

export const API_OPERATIONS: ApiOperation[] = ['status', 'start', 'stop', 'restart'];

export interface ApiToken {
  id: number;
  label: string;
  permissions: ApiOperation[];
  device_ids: number[];
  enabled: boolean;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
}

export interface ApiTokenStatsRow {
  token_id: number;
  label: string;
  total: number;
  operations: Record<ApiOperation, number>;
  last_used_at: number | null;
}

export interface ApiTokenLogRow {
  id: number;
  token_id: number;
  token_label: string | null;
  operation: ApiOperation;
  device_id: number | null;
  device_name: string | null;
  status_code: number;
  created_at: number;
}

export interface ScannedPort {
  port: number;
  service: string;
  banner: string | null;
}

export interface ScannedHost {
  ip: string;
  online: boolean;
  hostname: string | null;
  mac: string | null;
  vendor: string | null;
  ports: ScannedPort[];
  managed_device_id: number | null;
  managed_device_name: string | null;
}

export type ScanStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface ScanResult {
  success: boolean;
  status: ScanStatus;
  scannedCount: number;
  total: number;
  hosts: ScannedHost[];
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  error: string | null;
  errorCode: string | null;
}
