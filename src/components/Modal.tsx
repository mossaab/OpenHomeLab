import { motion } from 'motion/react';
import type { ReactNode } from 'react';

interface ModalProps {
  className?: string;
  onBackdropClick?: () => void;
  fullscreen?: boolean;
  hidden?: boolean;
  zIndex?: number;
  children: ReactNode;
}

export default function Modal({ className = '', onBackdropClick, fullscreen = false, hidden = false, zIndex = 50, children }: ModalProps) {
  return (
    <div
      className={`fixed inset-0 m-0 flex justify-center ${hidden ? 'hidden' : ''} ${fullscreen ? 'items-stretch p-0' : 'items-end sm:items-center p-0 sm:p-4'}`}
      style={{ zIndex }}
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onBackdropClick}
      />
      <motion.div
        initial={{ opacity: 0, scale: fullscreen ? 1 : 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className={`relative glass-card ${fullscreen ? 'w-full h-full max-w-none flex flex-col overflow-hidden' : className}`}
      >
        {children}
      </motion.div>
    </div>
  );
}
