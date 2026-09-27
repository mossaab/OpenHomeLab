import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, Maximize2, Minimize2, Minus, Terminal as TerminalIcon, X } from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { apiCall } from '../api';
import { Profile } from '../types';
import { useI18n } from '../i18n';
import Modal from './Modal';

export type TermStatus = 'selecting' | 'connecting' | 'open' | 'error';

const CTRL_BTN =
  'p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-white/10 transition-colors';

interface TerminalDialogProps {
  key?: string | number;
  target: 'host' | 'device' | 'ip';
  deviceId?: number;
  ip?: string;
  deviceName?: string;
  deviceProfileId?: number | null;
  minimized?: boolean;
  maximized?: boolean;
  active?: boolean;
  zIndex?: number;
  onClose: () => void;
  onMinimize?: () => void;
  onToggleMaximize?: () => void;
  onFocusFront?: () => void;
  onStatusChange?: (status: TermStatus) => void;
}

export default function TerminalDialog({
  target,
  deviceId,
  ip,
  deviceName,
  deviceProfileId = null,
  minimized = false,
  maximized = false,
  active = true,
  zIndex = 50,
  onClose,
  onMinimize,
  onToggleMaximize,
  onFocusFront,
  onStatusChange,
}: TerminalDialogProps) {
  const { t } = useI18n();
  const needProfile = target === 'host' || target === 'ip' || deviceProfileId === null;
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null);
  const [status, setStatus] = useState<TermStatus>(needProfile ? 'selecting' : 'connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsUrlRef = useRef<string>('');
  const observerRef = useRef<ResizeObserver | null>(null);
  const disposedRef = useRef(false);

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  useEffect(() => {
    if (minimized) return;
    const term = termRef.current;
    if (!term || status !== 'open') return;
    requestAnimationFrame(() => {
      if (!disposedRef.current) term.focus();
    });
  }, [minimized, maximized, active, status]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        try {
          wsRef.current.close();
        } catch {
          // socket already gone
        }
      }
      wsRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!needProfile) return;
    let cancelled = false;
    apiCall<Profile[]>('/profiles')
      .then((data) => {
        if (!cancelled) setProfiles(data);
      })
      .catch((e: any) => {
        if (!cancelled) {
          setStatus('error');
          setErrorMsg(e.message || t('term.loadProfilesFailed'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [needProfile, t]);

  const connect = useCallback(
    (profileId: number | null) => {
      setStatus('connecting');
      setErrorMsg('');
      const params = new URLSearchParams({ token: localStorage.getItem('auth_token') ?? '', target });
      if (target === 'device' && deviceId !== undefined) params.set('deviceId', String(deviceId));
      if (target === 'ip') params.set('ip', ip ?? '');
      if (profileId !== null) params.set('profileId', String(profileId));
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const wsUrl = `${proto}://${window.location.host}/api/terminal/ws?${params.toString()}`;
      wsUrlRef.current = wsUrl;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposedRef.current) return;
        setStatus('open');
        const el = containerRef.current;
        if (!el) return;
        const term = new XTerm({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          theme: { background: '#0b1220', foreground: '#e2e8f0' },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(el);
        requestAnimationFrame(() => {
          if (disposedRef.current) return;
          try {
            if (el.clientWidth > 0 && el.clientHeight > 0) {
              fit.fit();
              term.focus();
            }
          } catch {
            // container not measurable yet
          }
        });
        termRef.current = term;
        fitRef.current = fit;
        term.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        });
        const observer = new ResizeObserver(() => {
          try {
            const el = containerRef.current;
            if (!el || el.clientWidth <= 0 || el.clientHeight <= 0) return;
            fitRef.current?.fit();
            const t = termRef.current;
            if (t && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }));
            }
          } catch {
            // terminal not ready yet
          }
        });
        observer.observe(el);
        observerRef.current = observer;
      };

      ws.onmessage = (ev: MessageEvent) => {
        if (disposedRef.current) return;
        const data = ev.data as string | ArrayBuffer;
        if (typeof data === 'string' && data.startsWith('{')) {
          try {
            const msg = JSON.parse(data) as { type?: string; message?: string };
            if (msg.type === 'error') {
              setStatus('error');
              setErrorMsg(msg.message || t('term.connectionFailed'));
              ws.close();
              return;
            }
            if (msg.type === 'ready') {
              const t = termRef.current;
              if (t && ws.readyState === WebSocket.OPEN) {
                fitRef.current?.fit();
                ws.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }));
              }
              return;
            }
          } catch {
            // raw shell output that starts with '{'
          }
        }
        const term = termRef.current;
        if (!term) return;
        term.write(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer));
      };

      ws.onerror = () => {
        if (disposedRef.current) return;
        setStatus('error');
        setErrorMsg(t('term.cannotReach', { url: wsUrlRef.current, hint: t('term.transportHint') }));
      };

      ws.onclose = (ev: CloseEvent) => {
        if (disposedRef.current) return;
        if (ev.code >= 4000 && ev.reason) {
          setStatus('error');
          setErrorMsg(ev.reason);
        } else if (!termRef.current) {
          setStatus('error');
          setErrorMsg(t('term.closedEarly', { url: wsUrlRef.current, hint: t('term.transportHint') }));
        } else {
          try {
            termRef.current.write('\r\n\x1b[90m— connection closed —\x1b[0m\r\n');
          } catch {
            // terminal already disposed
          }
        }
      };
    },
    [target, deviceId, ip, t]
  );

  useEffect(() => {
    if (!needProfile) connect(null);
  }, [needProfile, connect]);

  const title =
    target === 'host'
      ? t('term.titleHost')
      : t('term.titleDevice', {
          name: (target === 'ip' ? ip : deviceName) ?? t('term.deviceFallback', { id: String(deviceId) }),
        });

  return (
    <Modal
      fullscreen={maximized}
      hidden={minimized}
      zIndex={zIndex}
      className="w-full sm:max-w-3xl h-[85dvh] sm:h-[72vh] mb-[env(safe-area-inset-bottom)] md:mb-0 flex flex-col overflow-hidden"
    >
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-white/10">
        <TerminalIcon size={16} className="text-cyan-600 dark:text-cyan-400" />
        <span className="font-semibold text-sm text-slate-800 dark:text-slate-200 truncate">{title}</span>
        {status === 'open' && (
          <span className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {t('term.connected')}
          </span>
        )}
        {status === 'connecting' && (
          <span className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 dark:text-slate-400">
            <Loader2 size={12} className="animate-spin" /> {t('term.connecting')}
          </span>
        )}
        <div className="ms-auto flex items-center gap-1">
          <button onClick={onMinimize} className={CTRL_BTN} title={t('term.minimizeTitle')} aria-label={t('term.minimizeAria')}>
            <Minus size={16} />
          </button>
          <button
            onClick={onToggleMaximize}
            className={CTRL_BTN}
            title={maximized ? t('term.restoreTitle') : t('term.maximizeTitle')}
            aria-label={maximized ? t('term.restoreAria') : t('term.maximizeAria')}
          >
            {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button onClick={onClose} className={CTRL_BTN} title={t('common.close')} aria-label={t('term.closeAria')}>
            <X size={18} />
          </button>
        </div>
      </div>

      {needProfile && (status === 'selecting' || status === 'error') ? (
        <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-4">
          <div>
            <h3 className="font-bold text-sm text-slate-800 dark:text-slate-200">{t('term.selectProfile')}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              {target === 'host' ? t('term.hostProfileNote') : t('term.deviceProfileNote')}
            </p>
          </div>
          {profiles.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/15 p-6 text-center text-xs text-slate-500 dark:text-slate-400">
              {t('term.noProfiles')}
            </div>
          ) : (
            <div className="space-y-2">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedProfileId(p.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-colors ${
                    selectedProfileId === p.id
                      ? 'border-cyan-500/60 bg-cyan-500/10'
                      : 'border-slate-200 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/5'
                  }`}
                >
                  <span className="w-3 h-3 rounded-full border shrink-0 bg-transparent" style={selectedProfileId === p.id ? { background: '#06b6d4', borderColor: '#06b6d4' } : { borderColor: 'rgb(148 163 184 / 0.5)' }} />
                  <span className="font-semibold text-sm text-slate-800 dark:text-slate-200 truncate">{p.name}</span>
                  <span className="ms-auto text-xs font-mono text-slate-500 dark:text-slate-400">
                    {p.username} · {p.auth_type === 'key' ? t('term.authKey') : t('term.authPassword')}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg glass border border-slate-200 dark:border-white/10 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-white/10 transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              disabled={selectedProfileId === null || profiles.length === 0}
              onClick={() => selectedProfileId !== null && connect(selectedProfileId)}
              className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-bold transition-colors disabled:opacity-50"
            >
              {t('term.connectBtn')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 relative bg-[#0b1220]">
          <div
            ref={containerRef}
            className="absolute inset-0 p-2"
            onMouseDown={() => {
              termRef.current?.focus();
              onFocusFront?.();
            }}
          />
          {status === 'connecting' && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-slate-400 text-sm pointer-events-none">
              <Loader2 size={16} className="animate-spin" /> {t('term.connecting')}
            </div>
          )}
        </div>
      )}

      {status === 'error' && (
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-rose-500/20 bg-rose-500/[.08] text-xs font-medium text-rose-600 dark:text-rose-400">
          <AlertCircle size={14} className="shrink-0" />
          <span className="min-w-0 break-words">{errorMsg}</span>
        </div>
      )}
    </Modal>
  );
}
