import { useEffect, useState, useSyncExternalStore } from 'react';
import { Spinner } from '@research-studio/ui';
import { ConnectScreen } from './features/connect/ConnectScreen';
import { LibraryScreen } from './features/library/LibraryScreen';
import { LiteratureScreen } from './features/literature/LiteratureScreen';
import { ProjectsScreen } from './features/projects/ProjectsScreen';
import { saveAll } from './features/workspace/actions';
import { Workspace } from './features/workspace/Workspace';
import {
  connect,
  consumePairingFragment,
  hasSession,
  reconnectWithRememberedToken,
  resumeSession,
  useConnection,
} from './lib/connection';
import { useLiveUpdates } from './lib/live';
import { useApplyTheme } from './lib/theme';

/**
 * Routes: `#/p/<projectId>` opens a project, `#/literature` the literature
 * search and `#/library` the library (`?from=<projectId>` returns there);
 * anything else shows the project list.
 */
type Route =
  | { page: 'projects' }
  | { page: 'project'; projectId: string }
  | { page: 'literature'; from: string | null }
  | { page: 'library'; from: string | null };

function readRoute(): string {
  return window.location.hash;
}

function parseRoute(hash: string): Route {
  const project = /^#\/p\/([A-Za-z0-9_-]+)$/.exec(hash);
  if (project) return { page: 'project', projectId: project[1]! };
  const literature = /^#\/literature(?:\?from=([A-Za-z0-9_-]+))?$/.exec(hash);
  if (literature) return { page: 'literature', from: literature[1] ?? null };
  const library = /^#\/library(?:\?from=([A-Za-z0-9_-]+))?$/.exec(hash);
  if (library) return { page: 'library', from: library[1] ?? null };
  return { page: 'projects' };
}

function useRoute(): [Route, (projectId: string | null) => void] {
  const hash = useSyncExternalStore((cb) => {
    window.addEventListener('hashchange', cb);
    return () => window.removeEventListener('hashchange', cb);
  }, readRoute);
  const navigate = (projectId: string | null) => {
    window.location.hash = projectId ? `/p/${projectId}` : '/';
  };
  return [parseRoute(hash), navigate];
}

/** Establish a session on load: pairing link, existing tab session, or remembered token. */
function useBootstrap(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const fragment = consumePairingFragment();
      if (fragment) {
        try {
          await connect({
            runtimeUrl: fragment.runtimeUrl ?? useConnection.getState().runtimeUrl,
            pairingToken: fragment.token,
            remember: true,
          });
        } catch {
          /* the connect screen shows the error */
        }
      } else if (hasSession()) {
        if (!(await resumeSession())) await reconnectWithRememberedToken();
      } else {
        await reconnectWithRememberedToken();
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return ready;
}

export function App() {
  const ready = useBootstrap();
  const status = useConnection((s) => s.status);
  const [route, navigate] = useRoute();
  useApplyTheme();
  useLiveUpdates();

  if (!ready) {
    return (
      <main className="grid min-h-dvh place-items-center bg-paper">
        <Spinner className="text-ink-faint" />
      </main>
    );
  }
  if (status !== 'connected') return <ConnectScreen />;
  if (route.page === 'literature') {
    const from = route.from;
    return <LiteratureScreen backLabel={from ? 'Back to project' : 'Projects'} onBack={() => navigate(from)} />;
  }
  if (route.page === 'library') {
    const from = route.from;
    return <LibraryScreen backLabel={from ? 'Back to project' : 'Projects'} onBack={() => navigate(from)} />;
  }
  if (route.page === 'project') {
    return (
      <Workspace
        key={route.projectId}
        projectId={route.projectId}
        onBack={() => {
          void saveAll().finally(() => navigate(null));
        }}
      />
    );
  }
  return <ProjectsScreen onOpen={(id) => navigate(id)} />;
}
