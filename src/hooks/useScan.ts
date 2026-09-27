import { useEffect, useMemo, useRef, useState } from 'react';
import { apiCall, ApiError } from '../api';
import type { ScanResult } from '../types';
import { useI18n } from '../i18n';

const IPv4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipToNum(ip: string): number | null {
  const m = IPv4_RE.exec(ip.trim());
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export interface ScanPreset {
  label: string;
  start: string;
  end: string;
}

interface UseScanOptions {
  onSettled?: (result: ScanResult) => void;
}

export function useScan({ onSettled }: UseScanOptions = {}) {
  const [startIp, setStartIp] = useState('');
  const [endIp, setEndIp] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanId, setScanId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [localError, setLocalError] = useState('');
  const [pollNow, setPollNow] = useState<number | null>(null);
  const [localRange, setLocalRange] = useState<{ startIp: string; endIp: string } | null>(null);
  const { t } = useI18n();

  const settledRef = useRef(onSettled);
  useEffect(() => {
    settledRef.current = onSettled;
  });

  useEffect(() => {
    apiCall<{ success: boolean; startIp: string | null; endIp: string | null }>('/scan/default-range')
      .then((data) => {
        if (data.startIp && data.endIp) {
          const range = { startIp: data.startIp, endIp: data.endIp };
          setLocalRange(range);
          setStartIp((v) => (v.trim() ? v : range.startIp));
          setEndIp((v) => (v.trim() ? v : range.endIp));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!scanning || !scanId) return;
    const timer = setInterval(async () => {
      try {
        const data = await apiCall<ScanResult>(`/scan/${scanId}`);
        setPollNow(Date.now());
        setResult(data);
        if (data.status === 'done' || data.status === 'failed' || data.status === 'cancelled') {
          setScanning(false);
          setCancelling(false);
          settledRef.current?.(data);
        }
      } catch (err) {
        console.error(err);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [scanning, scanId]);

  const rangePrefix = useMemo(() => {
    const parts = startIp.trim().split('.');
    if (parts.length < 3) return null;
    const prefix = parts.slice(0, 3).join('.');
    const octets = prefix.split('.').map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o > 255)) return null;
    return prefix;
  }, [startIp]);

  const presets = useMemo<ScanPreset[]>(() => {
    if (!rangePrefix) return [];
    return [
      {
        label: `${rangePrefix}.0 – ${rangePrefix}.255`,
        start: `${rangePrefix}.0`,
        end: `${rangePrefix}.255`,
      },
      {
        label: `${rangePrefix}.1 – ${rangePrefix}.126`,
        start: `${rangePrefix}.1`,
        end: `${rangePrefix}.126`,
      },
    ];
  }, [rangePrefix]);

  const progressPct = result && result.total > 0 ? (result.scannedCount / result.total) * 100 : 0;

  const cancelScan = async () => {
    if (!scanId || cancelling) return;
    setCancelling(true);
    try {
      await apiCall(`/scan/${scanId}/cancel`, { method: 'POST' });
    } catch (err) {
      console.error(err);
      setCancelling(false);
    }
  };

  const startScan = async (extraBody?: Record<string, unknown>) => {
    setLocalError('');
    const s = ipToNum(startIp);
    const e = ipToNum(endIp);
    if (s === null || e === null) {
      setLocalError(t('scanner.errInvalidIps'));
      return;
    }
    if (s > e) {
      setLocalError(t('scanner.errEndBeforeStart'));
      return;
    }
    if (e - s + 1 > 256) {
      setLocalError(t('scanner.errRangeTooLarge'));
      return;
    }
    setScanning(true);
    setResult(null);
    setCancelling(false);
    try {
      const body: Record<string, unknown> = { startIp: startIp.trim(), endIp: endIp.trim(), ...extraBody };
      const { scanId: id } = await apiCall<{ success: boolean; scanId: string }>('/scan', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setScanId(id);
    } catch (err) {
      setScanning(false);
      setLocalError(err instanceof ApiError ? err.message : t('scanner.startFailed'));
    }
  };

  return {
    startIp,
    setStartIp,
    endIp,
    setEndIp,
    setResult,
    scanning,
    cancelling,
    result,
    localError,
    setLocalError,
    pollNow,
    localRange,
    presets,
    progressPct,
    cancelScan,
    startScan,
  };
}
