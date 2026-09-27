type OsKind = 'apple' | 'windows' | 'raspberry' | 'ubuntu' | 'debian' | 'tux' | 'generic';

function resolveOsKind(osFamily?: string | null, osId?: string | null, osName?: string | null): OsKind {
  const lower = (v: string | null | undefined) => (v ?? '').toLowerCase();
  const family = lower(osFamily);
  const id = lower(osId);
  const name = lower(osName);
  if (family === 'macos') return 'apple';
  if (family === 'windows' || name.includes('windows')) return 'windows';
  if (id.includes('raspberrypi') || id.includes('raspbian') || name.includes('raspberry pi')) return 'raspberry';
  if (id.includes('ubuntu') || name.includes('ubuntu')) return 'ubuntu';
  if (id.includes('debian') || name.includes('debian')) return 'debian';
  if (family === 'linux' || name.includes('linux')) return 'tux';
  return 'generic';
}

function AppleMark() {
  return (
    <path d="M16.7 12.9c0-2 1.6-3 1.7-3.1-.9-1.4-2.3-1.5-2.8-1.6-1.2-.1-2.3.7-2.9.7s-1.6-.7-2.6-.7c-1.3 0-2.5.8-3.2 2-1.4 2.4-.4 6 1 8 .7 1 1.5 2.1 2.5 2s1.3-.7 2.5-.7 1.5.7 2.5.7 1.7-1 2.4-2c.4-.6.9-1.5 1.2-2.4 0 0-2-.8-2.1-2.8zM14.6 6.4c.5-.7.9-1.6.8-2.5-.8 0-1.7.5-2.3 1.2-.5.6-1 1.5-.8 2.4.9.1 1.8-.4 2.3-1.1z" />
  );
}

function WindowsMark() {
  return <path d="M3 5.6L10.5 4.7v6.9H3zM3 18.4l7.5.9v-6.9H3zM11.5 4.5L21 3.3v8.3h-9.5zM11.5 12.4H21v8.3l-9.5-1.2z" />;
}

function RaspberryMark() {
  return (
    <>
      <path d="M8.6 3.8c-1.6.4-2.7 1.4-3.2 3 1.5-.5 2.9-.4 4.1.3L8.6 3.8z" />
      <path d="M15.4 3.8c1.6.4 2.7 1.4 3.2 3-1.5-.5-2.9-.4-4.1.3l.9-3.3z" />
      <path d="M12 6.8c3.1 0 5.3 2.6 5.3 5.7S15.1 18.8 12 18.8s-5.3-3.2-5.3-6.3S8.9 6.8 12 6.8z" />
    </>
  );
}

function UbuntuMark() {
  return (
    <>
      <circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M12 3.6V12M12 12l-6.4 5.6M12 12l6.4 5.6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </>
  );
}

function DebianMark() {
  return (
    <path
      d="M12 3.2a8.8 8.8 0 1 0 8.8 8.8c0-2.6-1.7-4.9-4.1-5.9"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
    />
  );
}

function TuxMark() {
  return (
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2.5c-1.9 0-3.4 1.6-3.4 3.5v.9C7 8.4 5.8 10.2 5.8 12.3c0 1.8.7 3.2 1.4 4.1-.4.9-.6 1.8-.6 2.7 0 2.7 2.6 4.4 5.4 4.4s5.4-1.7 5.4-4.4c0-.9-.2-1.8-.6-2.7.7-.9 1.4-2.3 1.4-4.1 0-2.1-1.2-3.9-2.8-5.4v-.9c0-1.9-1.5-3.5-3.4-3.5zM12 7.6c-1.4 0-2.3 1.2-2.3 2.8s1 3.3 2.3 3.3 2.3-1.7 2.3-3.3S13.4 7.6 12 7.6zM10.4 15.4h3.2l-.6 2.2c-.1.3-.4.5-.7.5h-.6c-.3 0-.6-.2-.7-.5l-.6-2.2z"
    />
  );
}

function GenericMark() {
  return (
    <>
      <rect x="3" y="4.5" width="18" height="12.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M9 20.5h6M12 17v3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </>
  );
}

const TITLES: Record<OsKind, string> = {
  apple: 'macOS',
  windows: 'Windows',
  raspberry: 'Raspberry Pi OS',
  ubuntu: 'Ubuntu',
  debian: 'Debian',
  tux: 'Linux',
  generic: 'Unknown system',
};

export interface OsIconProps {
  osFamily?: string | null;
  osId?: string | null;
  osName?: string | null;
  size?: number;
  className?: string;
  title?: string;
}

export default function OsIcon({ osFamily, osId, osName, size = 16, className, title }: OsIconProps) {
  const kind = resolveOsKind(osFamily, osId, osName);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-label={title ?? TITLES[kind]} role="img" className={`shrink-0 ${className ?? ''}`}>
      {title && <title>{title}</title>}
      {kind === 'apple' && <AppleMark />}
      {kind === 'windows' && <WindowsMark />}
      {kind === 'raspberry' && <RaspberryMark />}
      {kind === 'ubuntu' && <UbuntuMark />}
      {kind === 'debian' && <DebianMark />}
      {kind === 'tux' && <TuxMark />}
      {kind === 'generic' && <GenericMark />}
    </svg>
  );
}
