import { useQuery } from '@tanstack/react-query';
import type { ArtifactVersion, VisualTask } from '@research-studio/api-contracts';
import { runtime } from '../../lib/connection';
import { queryClient } from '../../lib/queries';

export const visualKeys = {
  all: ['visual'] as const,
  providers: ['visual', 'providers'] as const,
  assets: (projectId: string | null) => ['visual', 'assets', projectId] as const,
  asset: (id: string) => ['visual', 'asset', id] as const,
  task: (id: string) => ['visual', 'task', id] as const,
  tasks: (projectId: string | null) => ['visual', 'tasks', projectId] as const,
  artifacts: (projectId: string | null) => ['visual', 'artifacts', projectId] as const,
  artifact: (id: string) => ['visual', 'artifact', id] as const,
  versions: (id: string) => ['visual', 'versions', id] as const,
  insertions: (projectId: string) => ['visual', 'insertions', projectId] as const,
};

export const useVisualProviders = () => useQuery({ queryKey: visualKeys.providers, queryFn: () => runtime().visual.providers(), staleTime: 60_000 });

export const useVisualAsset = (id: string | null) =>
  useQuery({ queryKey: visualKeys.asset(id ?? ''), queryFn: () => runtime().visual.asset(id!), enabled: !!id, staleTime: Infinity });

export const useVisualAssets = (projectId: string | null) =>
  useQuery({ queryKey: visualKeys.assets(projectId), queryFn: () => runtime().visual.assets(projectId ?? undefined) });

export const useVisualTask = (id: string | null) =>
  useQuery({
    queryKey: visualKeys.task(id ?? ''),
    queryFn: async () => (await runtime().visual.task(id!)).task,
    enabled: !!id,
    // Events keep it current; polling is the fallback when the socket is down.
    refetchInterval: (q) => (q.state.data && ['queued', 'running'].includes(q.state.data.status) ? 2_000 : false),
  });

export const useArtifacts = (projectId: string | null) =>
  useQuery({ queryKey: visualKeys.artifacts(projectId), queryFn: async () => (await runtime().visual.artifacts(projectId ?? undefined)).artifacts });

export const useArtifact = (id: string | null) =>
  useQuery({
    queryKey: visualKeys.artifact(id ?? ''),
    queryFn: () => runtime().visual.artifact(id!),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.version.compilationStatus === 'compiling' ? 2_000 : false),
  });

export const useVersions = (id: string | null) =>
  useQuery({ queryKey: visualKeys.versions(id ?? ''), queryFn: async () => (await runtime().visual.versions(id!)).versions, enabled: !!id });

export const useInsertions = (projectId: string | null) =>
  useQuery({ queryKey: visualKeys.insertions(projectId ?? ''), queryFn: async () => (await runtime().visual.insertions(projectId!)).insertions, enabled: !!projectId });

/** Runtime events: a task changed, or an artifact got a version or a compile result. */
export function onVisualTask(task: VisualTask): void {
  queryClient.setQueryData(visualKeys.task(task.id), task);
  if (task.artifactId) void queryClient.invalidateQueries({ queryKey: visualKeys.artifact(task.artifactId) });
  if (task.status === 'completed') void queryClient.invalidateQueries({ queryKey: ['visual', 'artifacts'] });
}

export function onVisualArtifact(artifactId: string, _version: ArtifactVersion | null): void {
  void queryClient.invalidateQueries({ queryKey: visualKeys.artifact(artifactId) });
  void queryClient.invalidateQueries({ queryKey: visualKeys.versions(artifactId) });
  void queryClient.invalidateQueries({ queryKey: ['visual', 'artifacts'] });
}

export function invalidateArtifact(artifactId: string): void {
  onVisualArtifact(artifactId, null);
}
