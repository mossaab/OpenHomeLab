import {
  Boxes,
  Box,
  Cpu,
  Server,
  Monitor,
  Laptop,
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
  Zap,
  type LucideIcon,
} from 'lucide-react';

export const GROUP_ICONS: Record<string, LucideIcon> = {
  boxes: Boxes,
  box: Box,
  cpu: Cpu,
  server: Server,
  monitor: Monitor,
  laptop: Laptop,
  router: Router,
  network: Network,
  'hard-drive': HardDrive,
  tv: Tv,
  printer: Printer,
  smartphone: Smartphone,
  tablet: Tablet,
  camera: Cctv,
  'gamepad-2': Gamepad2,
  'volume-2': Volume2,
  plug: Plug,
  zap: Zap,
};

export interface GroupColorSpec {
  value: string;
  label: string;
  chip: string;
  text: string;
  dot: string;
  swatch: string;
}

export const GROUP_COLORS: GroupColorSpec[] = [
  {
    value: 'indigo',
    label: 'Indigo',
    chip: 'bg-indigo-500/15 border-indigo-500/25 text-indigo-600 dark:text-indigo-300',
    text: 'text-indigo-600 dark:text-indigo-400',
    dot: 'bg-indigo-500',
    swatch: 'bg-indigo-500',
  },
  {
    value: 'violet',
    label: 'Violet',
    chip: 'bg-violet-500/15 border-violet-500/25 text-violet-600 dark:text-violet-300',
    text: 'text-violet-600 dark:text-violet-400',
    dot: 'bg-violet-500',
    swatch: 'bg-violet-500',
  },
  {
    value: 'sky',
    label: 'Sky',
    chip: 'bg-sky-500/15 border-sky-500/25 text-sky-700 dark:text-sky-300',
    text: 'text-sky-700 dark:text-sky-400',
    dot: 'bg-sky-500',
    swatch: 'bg-sky-500',
  },
  {
    value: 'cyan',
    label: 'Cyan',
    chip: 'bg-cyan-500/15 border-cyan-500/25 text-cyan-700 dark:text-cyan-300',
    text: 'text-cyan-700 dark:text-cyan-400',
    dot: 'bg-cyan-500',
    swatch: 'bg-cyan-500',
  },
  {
    value: 'emerald',
    label: 'Emerald',
    chip: 'bg-emerald-500/15 border-emerald-500/25 text-emerald-600 dark:text-emerald-300',
    text: 'text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
    swatch: 'bg-emerald-500',
  },
  {
    value: 'lime',
    label: 'Lime',
    chip: 'bg-lime-500/15 border-lime-500/25 text-lime-700 dark:text-lime-300',
    text: 'text-lime-700 dark:text-lime-400',
    dot: 'bg-lime-500',
    swatch: 'bg-lime-500',
  },
  {
    value: 'amber',
    label: 'Amber',
    chip: 'bg-amber-500/15 border-amber-500/25 text-amber-700 dark:text-amber-300',
    text: 'text-amber-700 dark:text-amber-400',
    dot: 'bg-amber-500',
    swatch: 'bg-amber-500',
  },
  {
    value: 'rose',
    label: 'Rose',
    chip: 'bg-rose-500/15 border-rose-500/25 text-rose-600 dark:text-rose-300',
    text: 'text-rose-600 dark:text-rose-400',
    dot: 'bg-rose-500',
    swatch: 'bg-rose-500',
  },
  {
    value: 'slate',
    label: 'Slate',
    chip: 'bg-slate-500/15 border-slate-500/25 text-slate-600 dark:text-slate-300',
    text: 'text-slate-600 dark:text-slate-400',
    dot: 'bg-slate-500',
    swatch: 'bg-slate-500',
  },
];

export function groupColorSpec(value: string | null | undefined): GroupColorSpec {
  return GROUP_COLORS.find((c) => c.value === value) ?? GROUP_COLORS[GROUP_COLORS.length - 1];
}

export function groupIcon(name: string | null | undefined): LucideIcon {
  return GROUP_ICONS[name ?? ''] ?? Boxes;
}
