import React from 'react';
import { AlertTriangle } from 'lucide-react';
import Modal from './Modal';
import { useI18n } from '../i18n/index';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ title, message, confirmLabel, loading = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useI18n();
  return (
    <Modal
      onBackdropClick={loading ? undefined : onCancel}
      zIndex={70}
      className="w-full sm:max-w-sm max-h-[92dvh] overflow-y-auto custom-scrollbar rounded-t-2xl sm:rounded-2xl px-6 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl border-b sm:border border-slate-200 dark:border-white/10"
    >
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-rose-500/20 text-rose-600 dark:text-rose-400 rounded-lg">
          <AlertTriangle size={20} />
        </div>
        <h3 className="font-medium text-slate-800 dark:text-slate-200">{title}</h3>
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">{message}</p>
      <div className="flex gap-3">
        <button
          onClick={onConfirm}
          disabled={loading}
          className="flex-1 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white font-medium px-4 py-2.5 rounded-lg transition-colors text-sm"
        >
          {confirmLabel}
        </button>
        <button
          onClick={onCancel}
          disabled={loading}
          className="flex-1 bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-700 dark:text-slate-300 font-medium px-4 py-2.5 rounded-lg transition-colors text-sm"
        >
          {t('common.cancel')}
        </button>
      </div>
    </Modal>
  );
}
