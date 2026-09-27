import { X, Zap } from 'lucide-react';
import Modal from './Modal';
import SettingsPanel from './SettingsPanel';
import type { Theme } from '../types';
import { useI18n } from '../i18n/index';

interface SettingsModalProps {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  onClose: () => void;
  onSaved?: () => void;
}

export default function SettingsModal({ theme, onThemeChange, onClose, onSaved }: SettingsModalProps) {
  const { t } = useI18n();
  return (
    <Modal
      onBackdropClick={onClose}
      zIndex={70}
      className="w-full sm:max-w-4xl h-[94dvh] sm:h-auto sm:max-h-[85vh] rounded-t-2xl sm:rounded-2xl shadow-2xl border-b sm:border border-slate-200 dark:border-white/10 flex flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between px-4 md:px-6 py-3 shrink-0">
        <h3 className="font-medium text-slate-800 dark:text-slate-200 text-lg flex items-center gap-2">
          <Zap size={20} className="text-indigo-600 dark:text-indigo-400" /> {t('settings.title')}
        </h3>
        <button
          onClick={onClose}
          className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-300 transition-colors p-1.5 rounded-lg hover:bg-slate-200/70 dark:hover:bg-white/10"
        >
          <X size={20} />
        </button>
      </div>

      <SettingsPanel theme={theme} onThemeChange={onThemeChange} onClose={onClose} onSaved={onSaved} />
    </Modal>
  );
}
