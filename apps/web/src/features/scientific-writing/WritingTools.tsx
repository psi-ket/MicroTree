import { PenLine, ScanText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { WritingFindingView } from '@research-studio/api-contracts';
import { REVIEW_ONLY_OPERATIONS, WRITING_OPERATIONS, type WritingOperation } from '@research-studio/shared-types';
import { Badge, Button, Input, Select, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage } from '../../lib/queries';
import type { EditorSelection } from '../../stores/editor';
import { ProposalReviewDialog } from '../citation-intelligence/ProposalReviewDialog';
import { ModelPicker, type ModelChoice } from '../evidence-review/ModelPicker';
import { privacyRefusal, useJob, withConsent } from '../evidence-review/state';

type Finding = WritingFindingView;

const LABEL: Record<WritingOperation, string> = {
  'academic-tone': 'Improve academic tone',
  concise: 'Make more concise',
  formal: 'Make more formal',
  readability: 'Improve readability',
  'remove-redundancy': 'Remove redundancy',
  transitions: 'Improve transitions',
  'reduce-ambiguity': 'Reduce ambiguity',
  overgeneralization: 'Find overgeneralisation',
  'qualify-claims': 'Qualify unsupported claims',
  terminology: 'Improve terminology',
  'observation-vs-interpretation': 'Separate observation from interpretation',
  'prediction-vs-result': 'Separate prediction from result',
  'undefined-concepts': 'Find undefined concepts',
  'causal-language': 'Improve causal language',
  'terminology-consistency': 'Check terminology consistency',
  'logical-flow': 'Improve logical flow',
  'paragraph-structure': 'Strengthen paragraph structure',
  'math-explanation': 'Improve mathematical explanation',
  'clarify-assumptions': 'Clarify assumptions',
  'equation-transitions': 'Improve equation transitions',
  'figure-descriptions': 'Improve figure descriptions',
  captions: 'Improve captions',
  definitions: 'Improve definitions',
  'unsupported-statements': 'Find unsupported statements',
  'needs-citations': 'Find claims needing citations',
  'incomplete-explanations': 'Find incomplete explanations',
  'internal-contradictions': 'Find contradictions in the text',
  'duplicated-explanations': 'Find duplicated explanations',
  'unclear-reasoning': 'Find unclear reasoning',
};

const GROUPS: [string, WritingOperation[]][] = [
  ['Academic style', ['academic-tone', 'concise', 'formal', 'readability', 'remove-redundancy', 'transitions', 'reduce-ambiguity']],
  ['Scientific precision', ['overgeneralization', 'qualify-claims', 'terminology', 'observation-vs-interpretation', 'prediction-vs-result', 'undefined-concepts', 'causal-language', 'terminology-consistency']],
  ['Technical writing', ['logical-flow', 'paragraph-structure', 'math-explanation', 'clarify-assumptions', 'equation-transitions', 'figure-descriptions', 'captions', 'definitions']],
  ['Critical review', ['unsupported-statements', 'needs-citations', 'incomplete-explanations', 'internal-contradictions', 'duplicated-explanations', 'unclear-reasoning']],
];

export function WritingTools({ projectId, selection, defaultModel }: { projectId: string; selection: EditorSelection | null; defaultModel: ModelChoice | null }) {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [op, setOp] = useState<WritingOperation>('academic-tone');
  const [guidance, setGuidance] = useState('');
  const [model, setModel] = useState<ModelChoice | null>(defaultModel);
  const [jobId, setJobId] = useState<string | null>(null);
  const [review, setReview] = useState<{ proposalId: string; warnings: string[] } | null>(null);
  const job = useJob(jobId);
  useEffect(() => setModel((m) => m ?? defaultModel), [defaultModel]);

  useEffect(() => {
    if (!job || job.id !== jobId) return;
    if (job.status === 'failed') {
      toast.error('The writing operation failed', { description: job.error ?? undefined });
      setJobId(null);
    }
    if (job.status !== 'completed') return;
    const r = job.result as { proposalId?: string | null; offerable?: boolean; warnings?: string[]; findings?: Finding[] } | null;
    if (r?.findings) setFindings((f) => [...(f ?? []), ...r.findings!]);
    else if (r?.proposalId) setReview({ proposalId: r.proposalId, warnings: r.warnings ?? [] });
    else if (r && !r.offerable) toast.warning('The rewrite was not offered', { description: (r.warnings ?? []).join(' ') });
    setJobId(null);
  }, [job, jobId]);

  if (!selection) return <p className="text-[12px] text-ink-muted">Select text in the editor to analyse or rewrite it.</p>;
  const target = { projectId, file: selection.file, startLine: selection.fromLine, startColumn: selection.startColumn, endLine: selection.toLine, endColumn: selection.endColumn, selectionText: selection.text };

  const analyse = async () => {
    try {
      const r = await runtime().evidence.analyzeWriting(target);
      setFindings(r.findings);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const run = async () => {
    if (!model) {
      toast.info('Choose a model for this operation');
      return;
    }
    await withConsent(
      async (consent) => {
        const r = await runtime().evidence.rewrite({ ...target, operation: op, guidance: guidance || null, model: { ...model, consent } });
        setJobId(r.job.id);
      },
      (err) => toast.error(privacyRefusal(err) ?? errorMessage(err)),
    );
  };
  const running = !!jobId;
  return (
    <section aria-label="Writing" className="flex flex-col gap-2" data-testid="writing-tools">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" onClick={() => void analyse()} data-testid="analyze-writing">
          <ScanText /> Check wording (rules)
        </Button>
      </div>
      <div className="flex flex-col gap-1.5 rounded-md border border-rule p-2">
        <Select aria-label="Writing operation" value={op} onChange={(e) => setOp(e.target.value as WritingOperation)} data-testid="writing-operation">
          {GROUPS.map(([g, ops]) => (
            <optgroup key={g} label={g}>
              {ops.map((o) => (
                <option key={o} value={o}>
                  {LABEL[o]}
                  {REVIEW_ONLY_OPERATIONS.includes(o) ? ' (findings)' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        <Input aria-label="Guidance" placeholder="Optional guidance, e.g. “keep it under 40 words”" value={guidance} maxLength={2000} onChange={(e) => setGuidance(e.target.value)} />
        <ModelPicker value={model} onChange={setModel} label="Writing model" />
        <Button size="sm" variant="primary" disabled={running || !model} onClick={() => void run()} data-testid="run-writing">
          {running ? <Spinner /> : <PenLine />} {REVIEW_ONLY_OPERATIONS.includes(op) ? 'Review' : 'Propose a rewrite'}
        </Button>
        <p className="text-[11px] text-ink-muted">Rewrites keep citations and references, are checked for changes of meaning, and are only applied after you review the diff.</p>
      </div>
      {findings ? (
        findings.length ? (
          <ul className="flex flex-col gap-1" data-testid="writing-findings">
            {findings.map((f, i) => (
              <li key={i} className="rounded-ctl border border-rule bg-raised px-2 py-1 text-[12px]">
                <Badge className="mr-1 text-ink" tone={f.severity === 'warning' ? 'warning' : 'neutral'}>
                  {LABEL[f.operation] ?? f.operation}
                </Badge>
                {f.message} {f.suggestion ? <span className="text-ink-muted">Suggestion: {f.suggestion}.</span> : null}
                {f.source === 'model' ? <span className="ml-1 text-ink-muted">(model)</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-ink-muted">No findings from the rules. That does not mean the text is correct.</p>
        )
      ) : null}
      {review ? <ProposalReviewDialog projectId={projectId} proposalId={review.proposalId} warnings={review.warnings} title={LABEL[op]} onClose={() => setReview(null)} /> : null}
    </section>
  );
}

export { WRITING_OPERATIONS };
