import type { THEMES } from '@research-studio/shared-types';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, FieldHint, Label, Select, Switch } from '@research-studio/ui';
import type { ReactNode } from 'react';
import { disconnect } from '../../lib/connection';
import { useRuntimeInfo, useSettings, useUpdateSettings } from '../../lib/queries';
import { useLayout } from '../../stores/layout';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <div>
        <Label className="text-ui text-ink">{label}</Label>
        {hint ? <FieldHint>{hint}</FieldHint> : null}
      </div>
      {children}
    </div>
  );
}

export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen } = useLayout();
  const settings = useSettings();
  const update = useUpdateSettings();
  const { data: info } = useRuntimeInfo();

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="w-[min(520px,calc(100vw-32px))]">
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription>Saved by the runtime and shared by every browser connected to it.</DialogDescription>
        <div className="mt-3 divide-y divide-rule">
          <Row label="Theme">
            <Select
              className="w-32"
              value={settings.theme}
              onChange={(e) => update.mutate({ theme: e.target.value as (typeof THEMES)[number] })}
              aria-label="Theme"
            >
              <option value="system">Match system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </Select>
          </Row>
          <Row label="Autosave" hint="Save a file after you stop typing.">
            <Switch checked={settings.autosave} onCheckedChange={(v) => update.mutate({ autosave: v })} aria-label="Autosave" />
          </Row>
          <Row label="Autosave delay">
            <Select
              className="w-32"
              value={String(settings.autosaveDelayMs)}
              disabled={!settings.autosave}
              onChange={(e) => update.mutate({ autosaveDelayMs: Number(e.target.value) })}
              aria-label="Autosave delay"
            >
              {[600, 1200, 2500, 5000].map((ms) => (
                <option key={ms} value={ms}>
                  {ms / 1000} s
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Compile after saving" hint="Recompile whenever autosave writes a file.">
            <Switch checked={settings.compileOnSave} onCheckedChange={(v) => update.mutate({ compileOnSave: v })} aria-label="Compile after saving" />
          </Row>
          <Row label="Editor font size">
            <Select
              className="w-32"
              value={String(settings.editorFontSize)}
              onChange={(e) => update.mutate({ editorFontSize: Number(e.target.value) })}
              aria-label="Editor font size"
            >
              {[12, 13, 14, 15, 16, 18, 20].map((n) => (
                <option key={n} value={n}>
                  {n} px
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Wrap long lines">
            <Switch checked={settings.editorWordWrap} onCheckedChange={(v) => update.mutate({ editorWordWrap: v })} aria-label="Wrap long lines" />
          </Row>
        </div>

        <h3 className="mt-5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-faint">Runtime</h3>
        <dl className="mt-2 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 font-mono text-2xs text-ink-muted">
          <dt>Version</dt>
          <dd className="text-ink">{info?.version ?? '—'}</dd>
          <dt>Workspace</dt>
          <dd className="break-all text-ink">{info?.workspaceRoot ?? '—'}</dd>
          <dt>latexmk</dt>
          <dd className="text-ink">{info ? (info.toolchain.latexmk.available ? info.toolchain.latexmk.version : 'not found') : '—'}</dd>
          <dt>SyncTeX</dt>
          <dd className="text-ink">{info ? (info.toolchain.synctex.available ? 'available' : 'not found') : '—'}</dd>
        </dl>
        <div className="mt-5 flex justify-between gap-2">
          <Button variant="ghost" className="text-danger" onClick={() => void disconnect(true)}>
            Disconnect and forget this runtime
          </Button>
          <Button variant="primary" onClick={() => setSettingsOpen(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
