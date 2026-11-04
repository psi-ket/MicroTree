import type { ConflictAnalysisView, EvidenceRecordView } from '@research-studio/api-contracts';
import { CONFLICT_LABEL } from './labels';

/** Supporting and opposing passages side by side, with the differences found. The researcher interprets them. */
export function ConflictView({ conflict, evidence }: { conflict: ConflictAnalysisView; evidence: EvidenceRecordView[] }) {
  const a = evidence.find((e) => e.id === conflict.supportingRecordId);
  const b = evidence.find((e) => e.id === conflict.opposingRecordId);
  return (
    <section className="rounded-md border border-danger/40 bg-danger-soft/20 p-2 text-ui" data-testid="conflict">
      <h4 className="font-medium">{CONFLICT_LABEL[conflict.category]}</h4>
      <p className="text-[12px]">{conflict.explanation}</p>
      <div className="mt-1.5 grid gap-2 md:grid-cols-2">
        {[
          ['Supporting', a],
          ['Opposing', b],
        ].map(([label, e]) => (
          <div key={label as string} className="rounded-ctl border border-rule bg-raised p-1.5 text-[12px]">
            <div className="font-medium">{label as string}</div>
            {e ? (
              <>
                <div className="text-ink-muted">
                  {(e as EvidenceRecordView).source.title} · {(e as EvidenceRecordView).source.location}
                </div>
                <p className="mt-1 whitespace-pre-wrap">{(e as EvidenceRecordView).source.text}</p>
              </>
            ) : null}
          </div>
        ))}
      </div>
      {conflict.differences.length ? (
        <table className="mt-1.5 w-full text-left text-[12px]">
          <thead className="text-ink-muted">
            <tr>
              <th className="font-normal">Aspect</th>
              <th className="font-normal">Supporting</th>
              <th className="font-normal">Opposing</th>
            </tr>
          </thead>
          <tbody>
            {conflict.differences.map((d, i) => (
              <tr key={i} className="border-t border-rule">
                <td className="pr-2">{d.aspect.replace(/-/g, ' ')}</td>
                <td className="pr-2">{d.supporting}</td>
                <td>{d.opposing}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="mt-1 text-[11px] text-ink-muted">Not resolved automatically; which result applies to your claim is your judgement.</p>
    </section>
  );
}
