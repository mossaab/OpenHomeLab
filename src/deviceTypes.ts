import {
  Monitor,
  Laptop,
  Server,
  Router,
  Network,
  HardDrive,
  Tv,
  Printer,
  Smartphone,
  Tablet,
  Cctv,
  Gamepad2,
  Volume2,
  Plug,
  Boxes,
  type LucideIcon,
} from 'lucide-react';
import type { Dict } from './i18n/index';

export interface DeviceTypeSpec {
  value: string;
  labelKey: keyof Dict;
  icon: LucideIcon;
  badge: string;
}

export const DEVICE_TYPES: DeviceTypeSpec[] = [
  {
    value: 'pc',
    labelKey: 'type.pc',
    icon: Monitor,
    badge: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 border-indigo-500/20',
  },
  {
    value: 'laptop',
    labelKey: 'type.laptop',
    icon: Laptop,
    badge: 'bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/20',
  },
  {
    value: 'server',
    labelKey: 'type.server',
    icon: Server,
    badge: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/20',
  },
  {
    value: 'router',
    labelKey: 'type.router',
    icon: Router,
    badge: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/20',
  },
  {
    value: 'switch',
    labelKey: 'type.switch',
    icon: Network,
    badge: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/20',
  },
  {
    value: 'nas',
    labelKey: 'type.nas',
    icon: HardDrive,
    badge: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/20',
  },
  {
    value: 'tv',
    labelKey: 'type.tv',
    icon: Tv,
    badge: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/20',
  },
  {
    value: 'printer',
    labelKey: 'type.printer',
    icon: Printer,
    badge: 'bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/20',
  },
  {
    value: 'phone',
    labelKey: 'type.phone',
    icon: Smartphone,
    badge: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/20',
  },
  {
    value: 'tablet',
    labelKey: 'type.tablet',
    icon: Tablet,
    badge: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/20',
  },
  {
    value: 'camera',
    labelKey: 'type.camera',
    icon: Cctv,
    badge: 'bg-rose-500/15 text-rose-600 dark:text-rose-300 border-rose-500/20',
  },
  {
    value: 'console',
    labelKey: 'type.console',
    icon: Gamepad2,
    badge: 'bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/20',
  },
  {
    value: 'audio',
    labelKey: 'type.audio',
    icon: Volume2,
    badge: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/20',
  },
  {
    value: 'iot',
    labelKey: 'type.iot',
    icon: Plug,
    badge: 'bg-lime-500/15 text-lime-700 dark:text-lime-300 border-lime-500/20',
  },
  {
    value: 'other',
    labelKey: 'type.other',
    icon: Boxes,
    badge: 'bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/20',
  },
];

export function deviceTypeSpec(type: string | null | undefined): DeviceTypeSpec {
  return DEVICE_TYPES.find((t) => t.value === type) ?? DEVICE_TYPES[DEVICE_TYPES.length - 1];
}
