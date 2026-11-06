import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, RefreshCw, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { PROVIDER_KINDS } from '@research-studio/ai-core';
import { MODEL_PROVIDER_KINDS, type AgentDescriptor, type AgentPermissionProfile, type ModelProviderKind, type ProviderConfigView } from '@research-studio/shared-types';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogTitle, FieldHint, Input, Label, Select, Spinner, Switch } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage } from '../../lib/queries';
import { aiKeys, useAgents, useAiStatus, useApprovals, useAssistant, useProviders } from './state';

const SOURCE_LABEL: Record<ProviderConfigView['credential']['source'], string> = {
  keyring: 'Key in OS credential store',
  file: 'Key in runtime data folder',
  memory: 'Key held in memory',
  env: 'Key from environment',
  none: 'No key',
};

const PROFILE_LABEL: Record<AgentPermissionProfile, { title: string; hint: string }> = {
  read: { title: 'Read files', hint: 'Reads a copy of the project; edits come back as proposals.' },
  'write-staged': { title: 'Edit a staged copy', hint: 'Edits a separate copy; every change is reviewed as a diff.' },
};

function SectionTitle({ children }: { children: string }) {
  return <h3 className="mt-5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-faint">{children}</h3>;
}

function ProviderRow({ provider }: { provider: ProviderConfigView }) {
  const qc = useQueryClient();
  const setTarget = useAssistant((s) => s.setTarget);
  const [editingKey, setEditingKey] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: aiKeys.providers });

  const saveKey = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await runtime().ai.updateProvider(provider.id, { apiKey: key.trim() || null });
      setKey('');
      setEditingKey(false);
      await refresh();
    } catch (err) {
      toast.error('Could not save the key', { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await runtime().ai.deleteProvider(provider.id);
      if (useAssistant.getState().target === `model:${provider.id}`) setTarget(null);
      await refresh();
    } catch (err) {
      toast.error('Could not remove the provider', { description: errorMessage(err) });
    }
  };

  const ok = provider.credential.configured || !provider.credential.required;
  return (
    <li className="py-2.5" data-testid="provider-row">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui text-ink">{provider.displayName}</div>
          <div className="truncate font-mono text-2xs text-ink-muted">
            {PROVIDER_KINDS[provider.kind].label}
            {provider.baseUrl ? ` · ${provider.baseUrl}` : ''}
            {provider.defaultModel ? ` · ${provider.defaultModel}` : ''}
          </div>
        </div>
        <Badge tone={ok ? 'success' : 'warning'}>{SOURCE_LABEL[provider.credential.source]}</Badge>
        <Button variant="ghost" size="icon-sm" aria-label={`Set API key for ${provider.displayName}`} onClick={() => setEditingKey((v) => !v)}>
          <KeyRound />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Remove ${provider.displayName}`} onClick={() => void remove()}>
          <Trash2 />
        </Button>
        <Button size="sm" onClick={() => setTarget(`model:${provider.id}`, provider.defaultModel ?? '')}>
          Use
        </Button>
      </div>
      {editingKey ? (
        <form className="mt-2 flex gap-2" onSubmit={(e) => void saveKey(e)}>
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="New API key (leave empty to remove)"
            aria-label="API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" variant="primary" disabled={busy}>
            {key.trim() ? 'Save key' : 'Remove key'}
          </Button>
        </form>
      ) : null}
    </li>
  );
}

function AddProvider() {
  const qc = useQueryClient();
  const setTarget = useAssistant((s) => s.setTarget);
  const [kind, setKind] = useState<ModelProviderKind>('anthropic');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const info = PROVIDER_KINDS[kind];
  const cli = info.transport === 'cli';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { provider } = await runtime().ai.createProvider({
        kind,
        displayName: name.trim() || info.label,
        baseUrl: cli ? null : baseUrl.trim() || null,
        defaultModel: model.trim() || null,
        apiKey: cli ? null : apiKey.trim() || null,
      });
      setApiKey('');
      setName('');
      setBaseUrl('');
      setModel('');
      await qc.invalidateQueries({ queryKey: aiKeys.providers });
      setTarget(`model:${provider.id}`, provider.defaultModel ?? '');
      toast.success(`${provider.displayName} is ready`);
    } catch (err) {
      toast.error('Could not add the provider', { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="mt-2 grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2 rounded-md border border-rule bg-paper p-3" onSubmit={(e) => void submit(e)}>
      <Label htmlFor="ai-kind">Service</Label>
      <Select id="ai-kind" value={kind} onChange={(e) => setKind(e.target.value as ModelProviderKind)}>
        {MODEL_PROVIDER_KINDS.map((k) => (
          <option key={k} value={k}>
            {PROVIDER_KINDS[k].label}
          </option>
        ))}
      </Select>
      <Label htmlFor="ai-name">Name</Label>
      <Input id="ai-name" placeholder={info.label} value={name} onChange={(e) => setName(e.target.value)} />
      {cli ? null : (
        <>
          <Label htmlFor="ai-url">Base URL</Label>
          <Input
            id="ai-url"
            placeholder={info.defaultBaseUrl ?? (kind === 'openai-compatible' ? 'https://… (required)' : 'Official endpoint')}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            spellCheck={false}
          />
        </>
      )}
      {!cli && (info.capabilities.requiresApiKey || kind === 'openai-compatible') ? (
        <>
          <Label htmlFor="ai-key">API key</Label>
          <Input
            id="ai-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={info.envKey ? `Or set ${info.envKey} for the runtime` : 'Optional'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </>
      ) : null}
      <Label htmlFor="ai-model">Default model</Label>
      <Input id="ai-model" placeholder={info.defaultModel ?? 'Model name'} value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
      <div className="col-span-2 flex items-center justify-between gap-3">
        <FieldHint>
          {cli
            ? `Runs ${kind === 'claude-cli' ? 'Claude Code' : 'Codex'} on this computer with your own sign-in, every tool off. What you send goes to ${kind === 'claude-cli' ? 'Anthropic' : 'OpenAI'}. Model "default" uses the CLI's own choice.`
            : 'The key goes to the local runtime only and is never stored in this browser.'}
        </FieldHint>
        <Button type="submit" variant="primary" disabled={busy}>
          Add provider
        </Button>
      </div>
    </form>
  );
}

function AgentRow({ agent, projectId, approved }: { agent: AgentDescriptor; projectId: string; approved: Set<string> }) {
  const qc = useQueryClient();
  const setTarget = useAssistant((s) => s.setTarget);
  const toggle = async (permission: AgentPermissionProfile, value: boolean) => {
    try {
      await runtime().ai.setAgentApproval(projectId, { agentId: agent.id, permission, approved: value });
      await qc.invalidateQueries({ queryKey: aiKeys.approvals(projectId) });
    } catch (err) {
      toast.error('Could not change the permission', { description: errorMessage(err) });
    }
  };
  return (
    <li className="py-2.5" data-testid="agent-row">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-ui text-ink">
            {agent.displayName} {agent.version ? <span className="font-mono text-2xs text-ink-muted">{agent.version}</span> : null}
          </div>
          <div className="truncate font-mono text-2xs text-ink-muted" title={agent.executable ?? undefined}>
            {agent.available ? (agent.auth.state === 'authenticated' ? `Signed in${agent.auth.method ? ` (${agent.auth.method})` : ''}` : (agent.auth.detail ?? 'Sign-in status unknown')) : agent.problem}
          </div>
        </div>
        <Badge tone={agent.available ? 'success' : 'neutral'}>{agent.available ? 'Found' : 'Not found'}</Badge>
        <Button size="sm" disabled={!agent.available} onClick={() => setTarget(`agent:${agent.id}`)}>
          Use
        </Button>
      </div>
      {agent.available ? (
        <div className="mt-2 space-y-1.5 pl-1">
          {agent.capabilities.permissionProfiles.map((p) => (
            <label key={p} className="flex items-center gap-2.5">
              <Switch checked={approved.has(`${agent.id}:${p}`)} onCheckedChange={(v) => void toggle(p, v)} aria-label={`${agent.displayName}: ${PROFILE_LABEL[p].title}`} />
              <span className="text-xs text-ink">{PROFILE_LABEL[p].title}</span>
              <span className="truncate text-2xs text-ink-faint">{PROFILE_LABEL[p].hint}</span>
            </label>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function SetupDialog({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { setupOpen, setSetupOpen } = useAssistant();
  const { data: providers = [] } = useProviders();
  const { data: agents, isFetching: agentsLoading } = useAgents();
  const { data: approvals = [] } = useApprovals(projectId);
  const { data: status } = useAiStatus();
  const approved = new Set(approvals.map((a) => `${a.agentId}:${a.permission}`));

  const rescan = async () => {
    const res = await runtime().ai.listAgents(true);
    qc.setQueryData(aiKeys.agents, res.agents);
  };

  return (
    <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
      <DialogContent className="top-[8vh] max-h-[84vh] w-[min(600px,calc(100vw-32px))] overflow-auto">
        <DialogTitle>Assistant setup</DialogTitle>
        <DialogDescription>
          Requests run through the local runtime. API keys stay there{status ? ` (${status.secretStore.kind === 'keyring' ? 'OS credential store' : status.secretStore.kind})` : ''}.
        </DialogDescription>
        {status?.secretStore.notice ? <p className="mt-2 rounded border border-warning/40 bg-warning-soft px-2.5 py-1.5 text-xs text-ink">{status.secretStore.notice}</p> : null}

        <SectionTitle>Models</SectionTitle>
        {providers.length ? (
          <ul className="divide-y divide-rule">
            {providers.map((p) => (
              <ProviderRow key={p.id} provider={p} />
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-ui text-ink-muted">Add a model service to ask questions about your manuscript.</p>
        )}
        <AddProvider />

        <div className="mt-5 flex items-center">
          <h3 className="mr-auto text-2xs font-semibold uppercase tracking-[0.08em] text-ink-faint">Command-line agents in this project</h3>
          <Button variant="ghost" size="sm" onClick={() => void rescan()} disabled={agentsLoading}>
            {agentsLoading ? <Spinner /> : <RefreshCw />} Rescan
          </Button>
        </div>
        {status && !status.agentsEnabled ? (
          <p className="mt-1 text-ui text-ink-muted">Agents are turned off on this runtime (RS_AGENTS=off).</p>
        ) : (
          <>
            <ul className="divide-y divide-rule">
              {(agents ?? []).map((a) => (
                <AgentRow key={a.id} agent={a} projectId={projectId} approved={approved} />
              ))}
            </ul>
            <FieldHint className="mt-1">
              An agent runs only in projects where you allow it, inside a copy of the project, with web access turned off. Nothing reaches your files until you accept the diff.
            </FieldHint>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
