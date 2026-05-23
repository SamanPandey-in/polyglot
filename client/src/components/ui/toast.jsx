import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

const ToastContext = createContext(null);

export function ToasterProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((toast) => {
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 8);
    const next = { id, duration: 5000, ...toast };
    setToasts((t) => [...t, next]);
    return id;
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      <div aria-live="polite" className="fixed top-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <Toast key={t.id} toast={t} onClose={() => removeToast(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ toast, onClose }) {
  const { id, title, message, duration = 5000, variant = 'default' } = toast;

  useEffect(() => {
    const timer = setTimeout(() => onClose(id), duration);
    return () => clearTimeout(timer);
  }, [id, duration, onClose]);

  const bg = variant === 'destructive' ? 'bg-red-600 text-white' : 'bg-slate-900 text-white';

  return (
    <div className={`max-w-sm rounded-md shadow-lg px-4 py-3 ${bg} ring-1 ring-black/10`}>
      {title && <div className="font-medium">{title}</div>}
      {message && <div className="text-sm opacity-90">{message}</div>}
      <button aria-label="dismiss" onClick={() => onClose(id)} className="ml-2 mt-1 text-xs underline">
        Dismiss
      </button>
    </div>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToasterProvider');
  return ctx;
}

export default ToasterProvider;
