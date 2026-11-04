import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { EvidenceSettings } from '@research-studio/api-contracts';
import { EVIDENCE_MODEL_TASKS, type EvidenceModelTask } from '@research-studio/shared-types';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, FieldHint, Label, Select } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, queryClient } from '../../lib/queries';
import { ModelPicker } from '../evidence-review/ModelPicker';
import { evidenceKeys, useEvidenceSettings } from '../evidence-review/state';

const TASK_LABEL: Record<EvidenceModelTask, string> = {
  extraction: 'Claim extraction',
  assessment: 'Evidence assessment',
  contradiction: 'Conflict analysis',
  writing: 'Wording',
  review: 'Manuscript review',
};

/** Per-project privacy for evidence and writing, and the model for each task. */
export function EvidenceSettingsDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const current = useEvidenceSettings(projectId).data;
  const [draft, setDraft] = useState<EvidenceSettings | null>(null);
  useEffect(() => {
    if (open && current) setDraft(current);
  }, [open, current]);
  const save = async () => {
    if (!draft) return;
    try {
      await runtime().evidence.updateSettings(projectId, draft);
      void queryClient.invalidateQueries({ queryKey: evidenceKeys.settings(projectId) });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(560px,calc(100vw-32px))]" aria-describedby="evset-desc" data-testid="evidence-settings">
        <DialogTitle>Evidence and writing settings</DialogTitle>
        <DialogDescription id="evset-desc">Where this project’s text may be processed, and which model to use for each task.</DialogDescription>
        {draft ? (
          <div className="mt-3 flex flex-col gap-3">
            <div>
              <Label htmlFor="ev-privacy">Privacy</Label>
              <Select id="ev-privacy" value={draft.privacyMode} onChange={(e) => setDraft({ ...draft, privacyMode: e.target.value as EvidenceSettings['privacyMode'] })} data-testid="privacy-mode">
                <option value="local-only">Local models only (default)</option>
                <option value="cloud-allowed">Allow cloud models, asking each time</option>
                <option value="confidential">Confidential: never send to cloud models</option>
              </Select>
              <FieldHint className="text-ink-muted">Only Ollama on this computer is local. Cloud use always needs your confirmation for each operation and is recorded.</FieldHint>
            </div>
            {EVIDENCE_MODEL_TASKS.map((t) => (
              <div key={t}>
                <Label>{TASK_LABEL[t]}</Label>
                <ModelPicker value={draft.models[t]} onChange={(v) => setDraft({ ...draft, models: { ...draft.models, [t]: v } })} label={TASK_LABEL[t]} />
              </div>
            ))}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} data-testid="save-evidence-settings">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
