import { useQuery } from '@tanstack/react-query';
import { Select } from '@research-studio/ui';
import { runtime } from '../../lib/connection';

export interface ModelChoice {
  providerId: string;
  model: string;
}

/** A provider and model for a task (providers come from the assistant's settings). */
export function ModelPicker({ value, onChange, label = 'Model' }: { value: ModelChoice | null; onChange: (v: ModelChoice | null) => void; label?: string }) {
  const providers = useQuery({ queryKey: ['ai', 'providers'], queryFn: () => runtime().ai.listProviders(), staleTime: 60_000 });
  const list = providers.data?.providers ?? [];
  return (
    <div className="flex items-center gap-1.5">
      <Select
        aria-label={`${label}: provider`}
        className="w-auto max-w-[45%]"
        value={value?.providerId ?? ''}
        onChange={(e) => {
          const p = list.find((x) => x.id === e.target.value);
          onChange(p ? { providerId: p.id, model: value?.providerId === p.id ? value.model : (p.defaultModel ?? '') } : null);
        }}
      >
        <option value="">No model (rules only)</option>
        {list
          .filter((p) => p.enabled)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
      </Select>
      <input
        aria-label={`${label}: model name`}
        className="h-7 min-w-0 flex-1 rounded-ctl border border-rule bg-raised px-2 font-mono text-[12px]"
        value={value?.model ?? ''}
        disabled={!value}
        placeholder="model"
        onChange={(e) => value && onChange({ ...value, model: e.target.value })}
      />
    </div>
  );
}
