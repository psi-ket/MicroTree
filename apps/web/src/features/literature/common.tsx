import { ExternalLink as ExternalLinkIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { safeExternalUrl } from '@research-studio/literature-engine/format';
import { LITERATURE_PROVIDERS, type LiteratureProviderId } from '@research-studio/shared-types';
import { cn } from '@research-studio/ui';
import { foundIn } from './model';

/**
 * Provenance as an edge-notched catalogue card: one hole per source, in a
 * fixed order (OpenAlex, Semantic Scholar, arXiv, Crossref). A hole cut open
 * to the card's edge means that source returned the work.
 */
export function Notches({
  providers,
  className,
  label = foundIn(providers),
}: {
  providers: LiteratureProviderId[];
  className?: string;
  /** null: decorative (the text next to it says the same). */
  label?: string | null;
}) {
  const a11y = label === null ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label, title: label };
  return (
    <span {...a11y} className={cn('flex w-[11px] flex-col gap-[4px]', className)}>
      {LITERATURE_PROVIDERS.map((p) =>
        providers.includes(p) ? (
          <span key={p} data-notch={p} className="block h-[6px] w-[11px] rounded-r-full bg-accent" />
        ) : (
          <span key={p} className="ml-[4px] block size-[6px] rounded-full border border-rule-strong" />
        ),
      )}
    </span>
  );
}

/** Opens in a new tab, and only for http(s) URLs. */
export function ExternalLink({ href, children, className }: { href: string | null | undefined; children: ReactNode; className?: string }) {
  const url = safeExternalUrl(href);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline [&_svg]:size-3', className)}
    >
      {children}
      <ExternalLinkIcon aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

const DOT = { success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', neutral: 'bg-ink-muted' } as const;

/** Small label; colour only in the dot, so the text keeps full contrast. */
export function Tag({ dot, title, children, className }: { dot?: keyof typeof DOT; title?: string; children: ReactNode; className?: string }) {
  return (
    <span title={title} className={cn('inline-flex h-[18px] items-center gap-1.5 rounded-[3px] bg-sunken px-1.5 text-[11px] font-medium text-ink', className)}>
      {dot ? <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', DOT[dot])} /> : null}
      {children}
    </span>
  );
}

/** The proofreader's margin bar that marks disagreement between sources. */
export function ProofBar({ className }: { className?: string }) {
  return <span aria-hidden className={cn('inline-block h-2.5 w-[2px] rounded-full bg-warning', className)} />;
}

export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error(`Could not copy the ${what.toLowerCase()}`, { description: 'The browser blocked clipboard access. Select the text and copy it yourself.' });
  }
}

export function SectionHeading({ children, id, level = 3 }: { children: ReactNode; id?: string; level?: 2 | 3 }) {
  const H = level === 2 ? 'h2' : 'h3';
  return (
    <H id={id} className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
      {children}
    </H>
  );
}
