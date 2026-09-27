import { useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle, XCircle, X } from 'lucide-react';

export interface ToastData {
  id: number;
  type: 'success' | 'error';
  message: string;
}

let _nextId = 0;

export function useToast() {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const addToast = useCallback((type: ToastData['type'], message: string) => {
    const id = ++_nextId;
    setToasts((prev) => [...prev, { id, type, message }]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timersRef.current.delete(id);
    }, 4000);
    timersRef.current.set(id, timer);
  }, []);

  const dismissToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toastContainer = (
    <div className="fixed z-[100] m-0 pointer-events-none inset-x-4 bottom-[env(safe-area-inset-bottom)] flex flex-col items-center gap-2 sm:inset-x-auto sm:end-4 sm:top-[64px] sm:bottom-auto sm:w-[384px]">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            className={`pointer-events-auto w-full flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border backdrop-blur-md ${
              t.type === 'success'
                ? 'bg-emerald-900/60 border-emerald-700/50 text-emerald-200'
                : 'bg-rose-900/60 border-rose-700/50 text-rose-200'
            }`}
          >
            {t.type === 'success' ? (
              <CheckCircle size={20} className="shrink-0" />
            ) : (
              <XCircle size={20} className="shrink-0" />
            )}
            <span className="text-sm font-medium flex-1">{t.message}</span>
            <button
              onClick={() => dismissToast(t.id)}
              className="p-1 rounded-lg hover:bg-slate-200/70 dark:hover:bg-white/10 transition-colors opacity-60 hover:opacity-100"
            >
              <X size={16} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );

  return { addToast, toastContainer };
}
