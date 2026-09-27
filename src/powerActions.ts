export const POWER_OFF_ACTIONS: readonly string[] = ['systemctl suspend', 'poweroff'];
export const REBOOT_ACTIONS: readonly string[] = ['reboot', 'systemctl reboot'];
export const HIBERNATE_ACTIONS: readonly string[] = ['systemctl hibernate'];
export const DEFAULT_POWER_OFF_ACTION = 'poweroff';
export const DEFAULT_REBOOT_ACTION = 'reboot';
export const DEFAULT_HIBERNATE_ACTION = 'systemctl hibernate';
