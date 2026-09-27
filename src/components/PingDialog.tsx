import { useState, useRef, useCallback, useEffect } from 'react';
import Modal from './Modal';
import { apiCall, ApiError } from '../api';
import { useI18n } from '../i18n';
import { X, Play, Square, Clock, Wifi, WifiOff } from 'lucide-react';

interface PingResult {
  alive: boolean;
  time: number | null;
  output: string;
}

interface PingEntry {
  seq: number;
  alive: boolean;
  time: number | null;
  timestamp: string;
}

export default function PingDialog({
  deviceId,
  deviceName,
  deviceIp,
  onClose,
}: {
  deviceId: number;
  deviceName: string;
  deviceIp: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [entries, setEntries] = useState<PingEntry[]>([]);
  const [error, setError] = useState('');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seqRef = useRef(0);
  const entriesEndRef = useRef<HTMLDivElement>(null);

  const doPing = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const result: PingResult = await apiCall(`/devices/${deviceId}/ping`, {
        method: 'POST',
      });
      const now = new Date().toLocaleTimeString();
      setEntries(prev => [...prev, { seq, alive: result.alive, time: result.time, timestamp: now }]);
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        setRunning(false);
        setError(t('scanner.errIcmpUnavailable'));
        return;
      }
      const now = new Date().toLocaleTimeString();
      setEntries(prev => [...prev, { seq, alive: false, time: null, timestamp: now }]);
    }
  }, [deviceId, t]);

  const startPing = () => {
    setError('');
    setEntries([]);
    seqRef.current = 0;
    setRunning(true);
    doPing();
    intervalRef.current = setInterval(doPing, 1000);
  };

  const stopPing = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setRunning(false);
  };

  const handleClose = () => {
    stopPing();
    onClose();
  };

  useEffect(() => {
    entriesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  return (
    <Modal
      onBackdropClick={handleClose}
      zIndex={70}
      className="rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[92dvh] sm:max-h-[85vh] flex flex-col shadow-2xl border-b sm:border border-slate-200 dark:border-white/10"
    >
        <div className="flex items-center justify-between p-5 border-b border-slate-200 dark:border-white/10">
          <div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-indigo-400"></span>
              {t('ping.title', { name: deviceName })}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5">{deviceIp}</p>
          </div>
          <button
            onClick={handleClose}
            title={t('common.close')}
            className="p-1.5 hover:bg-slate-200/70 dark:hover:bg-white/10 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-slate-200 dark:border-white/5 flex items-center gap-3">
          {!running ? (
            <button
              onClick={startPing}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600/20 hover:bg-emerald-500/30 text-emerald-600 dark:text-emerald-400 rounded-lg text-sm font-semibold transition-colors"
            >
              <Play size={16} fill="currentColor" />
              {t('ping.start')}
            </button>
          ) : (
            <button
              onClick={stopPing}
              className="flex items-center gap-2 px-4 py-2 bg-rose-600/20 hover:bg-rose-500/30 text-rose-600 dark:text-rose-400 rounded-lg text-sm font-semibold transition-colors"
            >
              <Square size={16} fill="currentColor" />
              {t('ping.stop')}
            </button>
          )}
          <span className="text-xs text-slate-500">
            {running ? t('ping.pingingEverySecond') : t('ping.idleHint')}
          </span>
          {running && (
            <span className="ms-auto flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
              {t('ping.live')}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-5 space-y-1.5 min-h-[200px]">
          {entries.length === 0 && !running && (
            <div className="text-center py-10 text-slate-500 text-sm">
              <Clock className="mx-auto mb-2 opacity-40" size={28} />
              {t('ping.pressStart', { ip: deviceIp })}
            </div>
          )}
          {entries.length === 0 && running && (
            <div className="text-center py-10 text-slate-500 text-sm">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-400 mx-auto mb-2"></div>
              {t('ping.pinging')}
            </div>
          )}
          {entries.map((entry) => (
            <div
              key={entry.seq}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-mono ${
                entry.alive
                  ? 'bg-emerald-500/5 text-emerald-300'
                  : 'bg-rose-500/5 text-rose-500 dark:text-rose-300'
              }`}
            >
              <span className="text-slate-500 w-8 text-right shrink-0">#{entry.seq}</span>
              <span className="text-slate-500 w-16 shrink-0">{entry.timestamp}</span>
              {entry.alive ? (
                <Wifi size={12} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
              ) : (
                <WifiOff size={12} className="text-rose-600 dark:text-rose-400 shrink-0" />
              )}
              <span className="font-semibold shrink-0">
                {entry.alive ? t('ping.reply') : t('ping.timeout')}
              </span>
              {entry.alive && entry.time !== null && (
                <span className="text-slate-500 dark:text-slate-400">{entry.time} ms</span>
              )}
            </div>
          ))}
          <div ref={entriesEndRef} />
        </div>

        {entries.length > 0 && (
          <div className="px-5 py-3 border-t border-slate-200 dark:border-white/5 flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
            <span>{t('ping.sent')} <strong className="text-slate-700 dark:text-slate-300">{entries.length}</strong></span>
            <span>{t('ping.received')} <strong className="text-emerald-600 dark:text-emerald-400">{entries.filter(e => e.alive).length}</strong></span>
            <span>{t('ping.lost')} <strong className="text-rose-600 dark:text-rose-400">{entries.filter(e => !e.alive).length}</strong></span>
            {entries.filter(e => e.alive && e.time !== null).length > 0 && (
              <span>
                {t('ping.avg')} <strong className="text-slate-700 dark:text-slate-300">
                  {(
                    entries
                      .filter(e => e.alive && e.time !== null)
                      .reduce((sum, e) => sum + (e.time as number), 0) /
                    entries.filter(e => e.alive && e.time !== null).length
                  ).toFixed(1)} ms
                </strong>
              </span>
            )}
          </div>
        )}

        {error && (
          <div className="px-5 py-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-500/5 border-t border-rose-500/20">
            {error}
          </div>
        )}
    </Modal>
  );
}
