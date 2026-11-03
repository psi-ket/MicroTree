import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { LITERATURE_SORTS, type LiteratureConnectionState, type LiteratureProviderStatus, type LiteratureSort } from '@research-studio/shared-types';
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogTitle, FieldHint, Input, Label, Select, Spinner, Switch } from '@research-studio/ui';
import { useQueryClient } from '@tanstack/react-query';
import { runtime } from '../../lib/connection';
import {
  errorMessage,
  keys,
  useLiteraturePreferences,
  useLiteratureProviders,
  useUpdateLiteraturePreferences,
  useUpdateLiteratureProvider,
} from '../../lib/queries';
import { ExternalLink, Notches, SectionHeading, Tag } from './common';
import { ago, rateLimitSummary, SORT_LABEL } from './model';

const CONNECTION: Record<LiteratureConnectionState, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | undefined }> = {
  unknown: { label: 'Not used yet', tone: undefined },
  ok: { label: 'Working', tone: 'success' },
  rate_limited: { label: 'Rate limited', tone: 'warning' },
  error: { label: 'Failing', tone: 'danger' },
  disabled: { label: 'Off', tone: undefined },
};

function ApiKeyForm({ provider }: { provider: LiteratureProviderStatus }) {
  const update = useUpdateLiteratureProvider();
  const [key, setKey] = useState('');
  const id = `lit-key-${provider.id}`;
  const save = (e: FormEvent) => {
    e.preventDefault();
    const value = key.trim();
    if (value.length < 8) {
      toast.error('That key looks too short.');
      return;
    }
    update.mutate(
      { id: provider.id, patch: { apiKey: value } },
      {
        onSuccess: () => {
          setKey('');
          toast.success(`${provider.name} key saved`);
        },
        onError: (err) => toast.error(`Could not save the ${provider.name} key`, { description: errorMessage(err) }),
      },
    );
  };
  const remove = () =>
    update.mutate(
      { id: provider.id, patch: { apiKey: null } },
      {
        onSuccess: () => toast.success(`${provider.name} key removed`),
        onError: (err) => toast.error(`Could not remove the ${provider.name} key`, { description: errorMessage(err) }),
      },
    );

  return (
    <form onSubmit={save} className="mt-2 space-y-1">
      <Label htmlFor={id}>API key (optional)</Label>
      <div className="flex gap-1.5">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={provider.apiKeySource === 'stored' ? 'Replace the saved key' : 'Paste a key'}
          className={cn('h-7 text-xs', key && 'font-mono')}
        />
        <Button type="submit" size="sm" disabled={!key.trim() || update.isPending}>
          Save key
        </Button>
        {provider.apiKeySource === 'stored' ? (
          <Button type="button" size="sm" variant="ghost" className="text-danger" onClick={remove} disabled={update.isPending}>
            Remove
          </Button>
        ) : null}
      </div>
      <FieldHint className="text-ink-muted">
        {provider.apiKeySource === 'stored'
          ? 'A key is saved in the runtime’s secret store. It is sent only to ' + provider.name + '.'
          : provider.apiKeySource === 'environment'
            ? 'Using the key from the runtime’s environment. A key saved here takes its place.'
            : 'Kept in the runtime’s secret store, never in the browser.'}
      </FieldHint>
    </form>
  );
}

function ProviderRow({ provider }: { provider: LiteratureProviderStatus }) {
  const qc = useQueryClient();
  const update = useUpdateLiteratureProvider();
  const [testing, setTesting] = useState(false);
  const conn = CONNECTION[provider.connection];

  const test = async () => {
    setTesting(true);
    try {
      const { provider: p } = await runtime().literature.testProvider(provider.id);
      qc.setQueryData(keys.literature.providers, (old: { providers: LiteratureProviderStatus[] } | undefined) =>
        old ? { ...old, providers: old.providers.map((x) => (x.id === p.id ? p : x)) } : old,
      );
      if (p.connection === 'ok') toast.success(`${p.name} answered`);
      else toast.error(`${p.name} did not answer`, { description: p.lastError ?? undefined });
    } catch (err) {
      toast.error(`Could not test ${provider.name}`, { description: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <li className="py-3" data-testid={`source-${provider.id}`}>
      <div className="flex items-center gap-2.5">
        <Notches providers={[provider.id]} label={null} className="scale-90" />
        <span className="text-[14px] font-medium text-ink">{provider.name}</span>
        <Tag dot={conn.tone}>{conn.label}</Tag>
        <Switch
          className="ml-auto"
          checked={provider.enabled}
          aria-label={`Search ${provider.name}`}
          disabled={update.isPending}
          onCheckedChange={(enabled) =>
            update.mutate(
              { id: provider.id, patch: { enabled } },
              { onError: (err) => toast.error(`Could not change ${provider.name}`, { description: errorMessage(err) }) },
            )
          }
        />
      </div>
      <div className="mt-1.5 space-y-0.5 pl-[22px] text-xs text-ink-muted">
        <p>{provider.authentication}</p>
        <p>{provider.limits}</p>
        {rateLimitSummary(provider.rateLimit) ? <p>{rateLimitSummary(provider.rateLimit)}</p> : null}
        {provider.lastError && provider.connection !== 'ok' ? (
          <p className="text-danger">
            {provider.lastError}
            {provider.lastErrorAt ? <span className="text-ink-muted"> · {ago(provider.lastErrorAt)}</span> : null}
          </p>
        ) : provider.lastSuccessAt ? (
          <p className="text-ink-muted">Last answered {ago(provider.lastSuccessAt)}</p>
        ) : null}
        <p className="flex flex-wrap items-center gap-x-3 pt-0.5">
          <ExternalLink href={provider.homepage}>About the API</ExternalLink>
          <ExternalLink href={provider.termsUrl}>Terms of use</ExternalLink>
          <Button size="sm" variant="link" className="h-auto px-0" onClick={() => void test()} disabled={!provider.enabled || testing}>
            {testing ? <Spinner /> : null}
            Test connection
          </Button>
        </p>
        {provider.acceptsApiKey && provider.enabled ? <ApiKeyForm provider={provider} /> : null}
      </div>
    </li>
  );
}

export function SourcesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useLiteratureProviders();
  const { preferences } = useLiteraturePreferences();
  const updatePrefs = useUpdateLiteraturePreferences();

  const patchPrefs = (patch: Parameters<typeof updatePrefs.mutate>[0]) =>
    updatePrefs.mutate(patch, { onError: (err) => toast.error('Could not save the setting', { description: errorMessage(err) }) });

  const clearCache = async () => {
    try {
      const { cleared } = await runtime().literature.clearCache();
      void qc.invalidateQueries({ queryKey: keys.literature.providers });
      toast.success(cleared === 1 ? 'Cleared 1 saved answer' : `Cleared ${cleared} saved answers`);
    } catch (err) {
      toast.error('Could not clear the cache', { description: errorMessage(err) });
    }
  };
  const clearHistory = async () => {
    try {
      await runtime().literature.clearHistory();
      void qc.invalidateQueries({ queryKey: keys.literature.history });
      toast.success('Recent searches cleared');
    } catch (err) {
      toast.error('Could not clear recent searches', { description: errorMessage(err) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[6vh] max-h-[88vh] w-[min(600px,calc(100vw-32px))] overflow-y-auto">
        <DialogTitle>Sources</DialogTitle>
        <DialogDescription>
          The runtime queries these services for you; your browser never contacts them. Only your search terms are sent{data?.contactConfigured ? ', plus the contact address set in RS_LITERATURE_MAILTO (OpenAlex and Crossref only)' : ''}.
        </DialogDescription>

        {isLoading ? (
          <Spinner className="mt-4 text-ink-muted" />
        ) : error ? (
          <p role="alert" className="mt-4 text-ui text-danger">
            {errorMessage(error)}
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-rule">
            {data?.providers.map((p) => (
              <ProviderRow key={p.id} provider={p} />
            ))}
          </ul>
        )}

        <div className="mt-2 border-t border-rule pt-4">
          <SectionHeading>Search defaults</SectionHeading>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="lit-default-sort">Sort by</Label>
              <Select id="lit-default-sort" value={preferences.sort} onChange={(e) => patchPrefs({ sort: e.target.value as LiteratureSort })} className="h-7 text-xs">
                {LITERATURE_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {SORT_LABEL[s]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lit-default-size">Results per page</Label>
              <Select id="lit-default-size" value={String(preferences.pageSize)} onChange={(e) => patchPrefs({ pageSize: Number(e.target.value) })} className="h-7 text-xs">
                {[10, 20, 30, 50].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </div>

        <div className="mt-5 border-t border-rule pt-4">
          <SectionHeading>Stored on this computer</SectionHeading>
          <div className="mt-2 flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="lit-save-history" className="text-ui text-ink">
                Remember recent searches
              </Label>
              <FieldHint className="text-ink-muted">Turning this off also deletes the searches already remembered.</FieldHint>
            </div>
            <Switch id="lit-save-history" checked={preferences.saveHistory} onCheckedChange={(v) => patchPrefs({ saveHistory: v })} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void clearHistory()}>
              Clear recent searches
            </Button>
            <Button size="sm" onClick={() => void clearCache()}>
              Clear saved answers
            </Button>
            {data ? (
              <span className="text-2xs text-ink-muted">
                {data.cache.entries} saved answer{data.cache.entries === 1 ? '' : 's'}, {Math.max(1, Math.round(data.cache.bytes / 1024))} KB
              </span>
            ) : null}
          </div>
          <FieldHint className="mt-1.5 text-ink-muted">Search answers are kept for an hour (arXiv: 6 hours) and single works for 7 days, so repeating a search does not use up a provider’s allowance.</FieldHint>
        </div>
      </DialogContent>
    </Dialog>
  );
}
