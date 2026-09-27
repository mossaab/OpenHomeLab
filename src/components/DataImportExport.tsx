import { useState, useCallback, type ChangeEvent } from 'react';
import { apiCall, ApiError } from '../api';
import { Download, Upload, CheckCircle2, AlertCircle, AlertTriangle } from 'lucide-react';
import { useI18n } from '../i18n';

interface DataImportExportProps {
  embedded?: boolean;
}

export default function DataImportExport({ embedded = false }: DataImportExportProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<'export' | 'import'>('export');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const downloadDate = new Date().toISOString().slice(0, 10);

  const handleExport = useCallback(async () => {
    setLoading(true);
    try {
      const data: { devices: any[]; profiles: any[] } = await apiCall('/data/export');
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `export-data-${downloadDate}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMessage({ text: t('data.exportOk'), type: 'success' });
    } catch (err: any) {
      const msg = err instanceof ApiError ? err.message : t('data.exportFailed');
      setMessage({ text: msg, type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [downloadDate, t]);

  const handleImport = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    setMessage(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.json')) {
      setMessage({ text: t('data.invalidFormat'), type: 'error' });
      return;
    }

    setLoading(true);
    try {
      const text = await file.text();
      const body: { devices?: any[]; profiles?: any[] } = JSON.parse(text);
      if (!Array.isArray(body.devices) && !Array.isArray(body.profiles)) {
        setMessage({ text: t('data.noArrays'), type: 'error' });
        return;
      }

      const result: { success: boolean } = await apiCall('/data/import', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (result.success) {
        setMessage({ text: t('data.importOk'), type: 'success' });
      } else {
        setMessage({ text: t('data.importError'), type: 'error' });
      }
    } catch (err: any) {
      const msg = err instanceof ApiError ? err.message : t('data.importError');
      setMessage({ text: msg, type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [t]);

  return (
    <div className="space-y-6">
      {!embedded && (
        <>
          <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">{t('data.title')}</h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm mb-4">{t('data.subtitle')}</p>
        </>
      )}

      <div className="flex gap-3 border-b border-slate-200 dark:border-white/5 pb-4">
        <button
          onClick={() => setActiveTab('export')}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            activeTab === 'export'
              ? 'bg-slate-100 dark:bg-white/10 text-white border border-slate-200 dark:border-white/10'
              : 'text-slate-500 dark:text-slate-400 hover:text-white'
          }`}
        >
          <Download size={18} className="inline me-2" />
          {t('data.tabExport')}
        </button>
        <button
          onClick={() => setActiveTab('import')}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            activeTab === 'import'
              ? 'bg-slate-100 dark:bg-white/10 text-white border border-slate-200 dark:border-white/10'
              : 'text-slate-500 dark:text-slate-400 hover:text-white'
          }`}
        >
          <Upload size={18} className="inline me-2" />
          {t('data.tabImport')}
        </button>
      </div>

      {message && (
        <div className={`p-3 rounded-lg text-sm flex items-center gap-2 ${
          message.type === 'success'
            ? 'bg-emerald-100 border border-emerald-300 text-emerald-800 dark:bg-emerald-500/15 dark:border-emerald-500/30 dark:text-emerald-300'
            : 'bg-rose-100 border border-rose-300 text-rose-800 dark:bg-rose-500/15 dark:border-rose-500/30 dark:text-rose-300'
        }`}>
          {message.type === 'success' ? (
            <CheckCircle2 size={16} className="shrink-0" />
          ) : (
            <AlertCircle size={16} className="shrink-0" />
          )}
          {message.text}
        </div>
      )}

      {activeTab === 'export' && (
        <div className="glass-card p-6 rounded-xl">
          <p className="text-slate-500 dark:text-slate-400 mb-4 text-sm">{t('data.exportDesc')}</p>

          <div className="flex items-center gap-2 p-3 mb-4 bg-amber-100 border border-amber-300 rounded text-sm text-amber-800 dark:bg-amber-500/15 dark:border-amber-500/30 dark:text-amber-300">
            <AlertTriangle size={16} className="shrink-0" />
            {t('data.passwordWarning')}
          </div>

          <button
            onClick={handleExport}
            disabled={loading}
            className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2 px-4 rounded-lg transition-colors disabled:opacity-50"
          >
            {loading ? t('data.exporting') : t('data.downloadJson')}
          </button>
        </div>
      )}

      {activeTab === 'import' && (
        <div className="glass-card p-6 rounded-xl">
          <p className="text-slate-500 dark:text-slate-400 mb-4 text-sm">{t('data.importDesc')}</p>

          <div className="flex items-center gap-3 border-2 border-dashed border-slate-200 dark:border-white/10 rounded-xl p-8 text-center hover:border-white/30 transition-colors cursor-pointer relative">
            <input
              type="file"
              accept=".json"
              onChange={handleImport}
              disabled={loading}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
            <Upload size={24} className="text-slate-500 flex-shrink-0" />
            <div>
              <p className="text-slate-700 dark:text-slate-300 font-medium">{t('data.dropzone')}</p>
              <p className="text-slate-500 text-xs mt-1">{t('data.jsonOnly')}</p>
            </div>
          </div>

          {loading && <p className="text-slate-500 dark:text-slate-400 text-sm mt-3">{t('data.importing')}</p>}
        </div>
      )}
    </div>
  );
}
