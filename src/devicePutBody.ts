import type { Device } from './types';

export function deviceToPutBody(
  device: Device,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name: device.name,
    ip: device.ip,
    mac: device.mac,
    hostname: device.hostname ?? null,
    type: device.type,
    profile_id: device.profile_id,
    broadcast_address: device.broadcast_address,
    base_power_w: device.base_power_w ?? null,
    interfaces: device.interfaces ?? [],
    active: device.active ? 1 : 0,
    poweroff_action: device.poweroff_action ?? '',
    reboot_action: device.reboot_action ?? '',
    hibernate_action: device.hibernate_action ?? '',
    disable_power: !!device.disable_power,
    disable_ping: !!device.disable_ping,
    disable_terminal: !!device.disable_terminal,
    disable_agent_update: !!device.disable_agent_update,
    ...overrides,
  };
}
