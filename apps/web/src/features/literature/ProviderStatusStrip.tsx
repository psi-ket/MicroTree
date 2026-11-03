import type { ProviderSearchOutcome } from '@research-studio/shared-types';
import { cn } from '@research-studio/ui';
import { Notches } from './common';
import { outcomeLabel, providerName } from './model';

const TONE: Record<ProviderSearchOutcome['status'], string> = {
  success: 'text-ink-muted',
  partial: 'text-warning',
  rate_limited: 'text-warning',
  failed: 'text-danger',
  skipped: 'text-ink-muted',
};

/** How each source took part in the last search, with the notch it marks on results. */
export function ProviderStatusStrip({ outcomes }: { outcomes: ProviderSearchOutcome[] }) {
  if (!outcomes.length) return null;
  // Most messages name their provider ("OpenAlex did not answer in time"); prefix the rest.
  const named = (o: ProviderSearchOutcome, text: string) => (text.startsWith(providerName(o.provider)) ? text : `${providerName(o.provider)}: ${text}`);
  const details = outcomes.flatMap((o) => [
    ...(o.error ? [{ key: `${o.provider}-error`, text: named(o, o.error) }] : []),
    ...(o.notes ?? []).map((note, i) => ({ key: `${o.provider}-note-${i}`, text: named(o, note) })),
  ]);
  return (
    <div className="border-b border-rule px-4 py-2" data-testid="provider-status">
      <ul aria-label="Sources searched" className="flex flex-wrap gap-x-5 gap-y-1.5">
        {outcomes.map((o) => (
          <li key={o.provider} className="flex items-center gap-2 text-xs" data-provider={o.provider} data-status={o.status}>
            <Notches providers={[o.provider]} label={null} className="scale-75" />
            <span className="font-medium text-ink">{providerName(o.provider)}</span>
            <span className={cn('tabular-nums', TONE[o.status])}>{outcomeLabel(o)}</span>
            {o.fromCache ? <span className="font-mono text-2xs text-ink-muted">cached</span> : null}
          </li>
        ))}
      </ul>
      {details.length ? (
        <ul className="mt-1.5 space-y-0.5 text-2xs text-ink-muted">
          {details.map((d) => (
            <li key={d.key}>{d.text}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
