import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource-variable/atkinson-hyperlegible-mono';
import '@fontsource-variable/stix-two-text';
import '@fontsource-variable/stix-two-text/wght-italic.css';
import './index.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@research-studio/ui';
import { App } from './App';
import { ErrorScreen } from './ErrorScreen';
import { queryClient } from './lib/queries';
import { useResolvedTheme } from './lib/theme';

function ThemedToaster() {
  const theme = useResolvedTheme();
  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      offset={36}
      toastOptions={{ className: 'font-sans text-ui' }}
      closeButton
    />
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={400}>
        <ErrorScreen>
          <App />
        </ErrorScreen>
        <ThemedToaster />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
