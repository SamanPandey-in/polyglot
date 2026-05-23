import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import * as Sentry from '@sentry/react';
import { store } from '@/app/store';
import App from './App.jsx';
import ToasterProvider from '@/components/ui/toast';
import './index.css';

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE || 0.1),
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Sentry.ErrorBoundary
      fallback={({ error }) => (
        <div style={{ padding: '2rem', fontFamily: 'monospace', color: '#dc2626' }}>
          <h2>Something went wrong</h2>
          <p style={{ fontSize: '0.875rem', color: '#6b7280' }}>
            {error?.message || 'Unknown error'}
          </p>
        </div>
      )}
    >
      <Provider store={store}>
        <ToasterProvider>
          <App />
        </ToasterProvider>
      </Provider>
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
