import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@research-studio/ui';
import { KEYS, local } from './lib/storage';

/** Browser-saved view settings that a reset clears; the runtime connection is kept. */
const VIEW_KEYS = [KEYS.layout, 'rs.ai.target', 'rs.ai.permission', 'rs.visual.settings'];

interface State {
  error: Error | null;
  componentStack: string;
}

/**
 * Shows a render error instead of an empty page, with the details needed to
 * report it and a way out that does not lose the connection or any files.
 */
export class ErrorScreen extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, componentStack: '' };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Research Studio stopped rendering:', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  override render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    const details = `${error.name}: ${error.message}\n${error.stack ?? ''}\n\nComponents:${componentStack}`;
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 bg-panel px-4 py-10 text-ink">
        <h1 className="font-serif text-xl">This page stopped working</h1>
        <p className="text-ui text-ink-muted">
          Saved files are kept by the runtime; an edit made in the last moment before this happened may not have been saved. Reload to try again. If it happens again, reset the view settings saved in this browser (open panels, chosen assistant, Visual Studio choices); the connection to the runtime is kept.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => window.location.reload()}>Reload</Button>
          <Button
            variant="secondary"
            onClick={() => {
              for (const key of VIEW_KEYS) local.remove(key);
              window.location.reload();
            }}
          >
            Reset view settings and reload
          </Button>
          <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(details)}>
            Copy error details
          </Button>
        </div>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded border border-rule bg-sunken p-3 font-mono text-xs text-ink-muted">{details}</pre>
      </main>
    );
  }
}
