import { KeyRound, PlugZap } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, FieldHint, Input, Label, Spinner } from '@research-studio/ui';
import { connect, rememberedPairingToken, useConnection } from '../../lib/connection';

/**
 * Pairing screen. The runtime prints a connect link (with the token in the URL
 * fragment, which is never sent to a server) and the token itself; either works.
 */
export function ConnectScreen() {
  const { runtimeUrl, status, error } = useConnection();
  const [url, setUrl] = useState(runtimeUrl);
  const [token, setToken] = useState(() => rememberedPairingToken() ?? '');
  const [remember, setRemember] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const busy = status === 'connecting';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (token.trim().length < 32) {
      setLocalError('Paste the full pairing token printed by the runtime (at least 32 characters).');
      return;
    }
    try {
      await connect({ runtimeUrl: url, pairingToken: token, remember });
    } catch (err) {
      if (!(err instanceof Error) || useConnection.getState().error === null) {
        setLocalError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const message = localError ?? error;

  return (
    <main className="rs-graph-paper grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[440px] animate-[rs-rise_320ms_ease-out]">
        <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-accent">Research Studio</p>
        <h1 className="mt-2 font-display text-[34px] leading-[1.1] text-ink">Connect to your local runtime</h1>
        <p className="mt-3 text-[14px] leading-6 text-ink-muted">
          Your projects, files and LaTeX toolchain stay on this computer. The browser talks to the runtime over
          localhost and never runs commands itself.
        </p>

        <form onSubmit={(e) => void submit(e)} className="mt-7 rounded-lg border border-rule bg-panel p-5 shadow-float" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="runtime-url">Runtime address</Label>
            <Input id="runtime-url" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off" />
          </div>
          <div className="mt-4 space-y-1.5">
            <Label htmlFor="pairing-token">Pairing token</Label>
            <Input
              id="pairing-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Printed when the runtime starts"
              spellCheck={false}
              autoComplete="off"
              className="font-mono"
            />
            <FieldHint>
              Run <code className="font-mono text-ink">pnpm dev:runtime</code> and open the link it prints, or paste the
              token from it.
            </FieldHint>
          </div>
          <label className="mt-4 flex items-center gap-2 text-ui text-ink-muted">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-accent" />
            Remember the token on this device
          </label>
          {message ? (
            <p role="alert" className="mt-4 rounded-ctl border border-danger/30 bg-danger-soft px-3 py-2 text-ui text-danger">
              {message}
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="lg" className="mt-5 w-full" disabled={busy}>
            {busy ? <Spinner /> : <PlugZap />}
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        </form>
        <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-ink-faint">
          <KeyRound className="mt-0.5 size-3.5 shrink-0" />
          <span>
            The token grants full access to your projects. If it leaks, rotate it with{' '}
            <code className="break-all font-mono">pnpm --filter @research-studio/runtime token:rotate</code>.
          </span>
        </p>
      </div>
    </main>
  );
}
