import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RuntimeApiError } from '@research-studio/api-contracts';
import {
  DEFAULT_LITERATURE_PREFERENCES,
  DEFAULT_SETTINGS,
  DEFAULT_LIBRARY_PREFERENCES,
  type AppSettings,
  type LibraryItemQuery,
  type LibraryPreferences,
  type LiteraturePreferences,
  type LiteratureProviderId,
  type Project,
} from '@research-studio/shared-types';
import { runtime, useConnection } from './connection';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => !(error instanceof RuntimeApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
  },
});

export const keys = {
  info: ['runtime-info'] as const,
  settings: ['settings'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  tree: (id: string) => ['tree', id] as const,
  symbols: (id: string) => ['symbols', id] as const,
  jobs: (id: string) => ['jobs', id] as const,
  literature: {
    providers: ['literature', 'providers'] as const,
    preferences: ['literature', 'preferences'] as const,
    history: ['literature', 'history'] as const,
    related: (kind: 'references' | 'citations', workId: string) => ['literature', kind, workId] as const,
    author: (authorId: string) => ['literature', 'author', authorId] as const,
  },
  library: {
    all: ['library'] as const,
    overview: ['library', 'overview'] as const,
    items: (query: LibraryItemQuery) => ['library', 'items', query] as const,
    item: (id: string) => ['library', 'item', id] as const,
    collections: ['library', 'collections'] as const,
    tags: ['library', 'tags'] as const,
    jobs: ['library', 'jobs'] as const,
    duplicates: ['library', 'duplicates'] as const,
    preferences: ['library', 'preferences'] as const,
    zotero: ['library', 'zotero'] as const,
  },
  references: (projectId: string) => ['references', projectId] as const,
};

export const useRuntimeInfo = () => useQuery({ queryKey: keys.info, queryFn: () => runtime().runtimeInfo(), staleTime: 5 * 60_000 });

export const useProjects = () =>
  useQuery({ queryKey: keys.projects, queryFn: async () => (await runtime().listProjects()).projects });

export const useProject = (id: string) =>
  useQuery({ queryKey: keys.project(id), queryFn: async () => (await runtime().getProject(id)).project });

export const useTree = (id: string) =>
  useQuery({ queryKey: keys.tree(id), queryFn: async () => (await runtime().tree(id)).tree });

export const useSymbols = (id: string) =>
  useQuery({ queryKey: keys.symbols(id), queryFn: () => runtime().symbols(id), staleTime: 10_000 });

export const useJobs = (id: string) =>
  useQuery({ queryKey: keys.jobs(id), queryFn: async () => (await runtime().listJobs(id)).jobs });

export function useSettings(): AppSettings {
  const connected = useConnection((s) => s.status === 'connected');
  const { data } = useQuery({
    queryKey: keys.settings,
    queryFn: async () => (await runtime().getSettings()).settings,
    enabled: connected,
  });
  return data ?? DEFAULT_SETTINGS;
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AppSettings>) => runtime().updateSettings(patch),
    onMutate: (patch) => {
      const previous = qc.getQueryData<AppSettings>(keys.settings);
      qc.setQueryData(keys.settings, { ...(previous ?? DEFAULT_SETTINGS), ...patch });
      return { previous };
    },
    onError: (_err, _patch, ctx) => {
      if (ctx?.previous) qc.setQueryData(keys.settings, ctx.previous);
    },
    onSuccess: (res) => qc.setQueryData(keys.settings, res.settings),
  });
}

export function useUpdateProject(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Pick<Project, 'name' | 'mainFile' | 'engine'>>) => runtime().updateProject(id, patch),
    onSuccess: ({ project }) => {
      qc.setQueryData(keys.project(id), project);
      void qc.invalidateQueries({ queryKey: keys.projects });
    },
  });
}

// ------------------------------------------------------------ literature

export const useLiteratureProviders = () =>
  useQuery({ queryKey: keys.literature.providers, queryFn: () => runtime().literature.providers(), staleTime: 10_000 });

export function useLiteraturePreferences(): { preferences: LiteraturePreferences; loaded: boolean } {
  const { data, isSuccess } = useQuery({
    queryKey: keys.literature.preferences,
    queryFn: async () => (await runtime().literature.preferences()).preferences,
  });
  return { preferences: data ?? DEFAULT_LITERATURE_PREFERENCES, loaded: isSuccess };
}

export function useUpdateLiteraturePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<LiteraturePreferences>) => runtime().literature.updatePreferences(patch),
    onSuccess: ({ preferences }) => {
      qc.setQueryData(keys.literature.preferences, preferences);
      if (!preferences.saveHistory) void qc.invalidateQueries({ queryKey: keys.literature.history });
    },
  });
}

export function useUpdateLiteratureProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: LiteratureProviderId; patch: { enabled?: boolean; apiKey?: string | null } }) =>
      runtime().literature.updateProvider(id, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.literature.providers }),
  });
}

export const useLiteratureHistory = (enabled: boolean) =>
  useQuery({ queryKey: keys.literature.history, queryFn: async () => (await runtime().literature.history(30)).entries, enabled });

export const useRelatedWorks = (kind: 'references' | 'citations', workId: string, enabled: boolean) =>
  useQuery({
    queryKey: keys.literature.related(kind, workId),
    queryFn: ({ signal }) =>
      kind === 'references' ? runtime().literature.references(workId, 25, signal) : runtime().literature.citations(workId, 25, signal),
    enabled,
    staleTime: 10 * 60_000,
  });

export const useAuthorProfile = (authorId: string | null) =>
  useQuery({
    queryKey: keys.literature.author(authorId ?? ''),
    queryFn: async ({ signal }) => (await runtime().literature.author(authorId!, signal)).author,
    enabled: authorId !== null,
    staleTime: 10 * 60_000,
  });

// --------------------------------------------------------------- library

export const useLibraryOverview = () =>
  useQuery({ queryKey: keys.library.overview, queryFn: async () => (await runtime().library.overview()).overview });

export const useLibraryItems = (query: LibraryItemQuery) =>
  useQuery({
    queryKey: keys.library.items(query),
    queryFn: ({ signal }) => runtime().library.items(query, signal),
    placeholderData: (previous) => previous,
  });

export const useLibraryItem = (id: string | null) =>
  useQuery({ queryKey: keys.library.item(id ?? ''), queryFn: async () => (await runtime().library.item(id!)).item, enabled: id !== null });

export const useCollections = () =>
  useQuery({ queryKey: keys.library.collections, queryFn: async () => (await runtime().library.collections()).collections });

export const useLibraryTags = () => useQuery({ queryKey: keys.library.tags, queryFn: async () => (await runtime().library.tags()).tags });

export const useLibraryJobs = () => useQuery({ queryKey: keys.library.jobs, queryFn: async () => (await runtime().library.jobs()).jobs });

export const useZoteroStatus = (probeLocal = false) =>
  useQuery({ queryKey: [...keys.library.zotero, probeLocal], queryFn: async () => (await runtime().library.zotero.status(probeLocal)).status });

export function useLibraryPreferences(): LibraryPreferences {
  const { data } = useQuery({ queryKey: keys.library.preferences, queryFn: async () => (await runtime().library.preferences()).preferences });
  return data ?? DEFAULT_LIBRARY_PREFERENCES;
}

export function useUpdateLibraryPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<LibraryPreferences>) => runtime().library.updatePreferences(patch),
    onSuccess: ({ preferences }) => qc.setQueryData(keys.library.preferences, preferences),
  });
}

export const useProjectReferences = (projectId: string) =>
  useQuery({ queryKey: keys.references(projectId), queryFn: () => runtime().references.get(projectId), staleTime: 5_000 });

/** After a library change: everything that shows library data refetches when next shown. */
export function invalidateLibrary(): void {
  void queryClient.invalidateQueries({ queryKey: keys.library.all });
  void queryClient.invalidateQueries({ queryKey: ['references'] });
}

export function errorMessage(err: unknown): string {
  if (err instanceof RuntimeApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
