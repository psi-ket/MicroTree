import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { editorLanguageFor } from '@research-studio/document-engine';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage } from '../../lib/queries';
import { useResolvedTheme } from '../../lib/theme';
import { useEditor } from '../../stores/editor';
import { overwriteOnDisk, reloadFromDisk } from '../workspace/actions';

/** Side by side: the file as it is on disk now (left) and the unsaved editor version (right). */
export function CompareDialog({ projectId, path, open, onClose }: { projectId: string; path: string; open: boolean; onClose: () => void }) {
  const theme = useResolvedTheme();
  const mine = useEditor((s) => s.buffers[path]?.content ?? '');
  const diffRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  const disk = useQuery({
    queryKey: ['compare-disk', projectId, path],
    queryFn: () => runtime().readFile(projectId, path),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });

  // See ReviewDialog: dispose the models only after the diff widget let go of them.
  useEffect(() => {
    if (!open) return;
    return () => {
      const model = diffRef.current?.getModel();
      diffRef.current = null;
      setTimeout(() => {
        model?.original.dispose();
        model?.modified.dispose();
      }, 0);
    };
  }, [open]);

  const onMount: DiffOnMount = (diff) => {
    diffRef.current = diff;
  };

  const decide = async (choice: () => Promise<void>) => {
    await choice();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="top-[5vh] flex h-[88vh] w-[min(1200px,calc(100vw-32px))] flex-col" aria-describedby="compare-desc" data-testid="compare-dialog">
        <DialogTitle className="pr-8">
          <span className="font-mono text-[15px]">{path}</span>
        </DialogTitle>
        <DialogDescription id="compare-desc">Left: the file on disk now. Right: your unsaved version. Nothing is saved until you choose.</DialogDescription>
        <div className="mt-3 min-h-0 flex-1 overflow-hidden rounded-md border border-rule">
          {disk.isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : disk.error ? (
            <p className="p-4 text-ui text-danger">{errorMessage(disk.error)}</p>
          ) : disk.data ? (
            <DiffEditor
              original={disk.data.content}
              modified={mine}
              language={editorLanguageFor(path)}
              theme={theme === 'dark' ? 'rs-dark' : 'rs-light'}
              onMount={onMount}
              keepCurrentOriginalModel
              keepCurrentModifiedModel
              options={{
                readOnly: true,
                originalEditable: false,
                renderSideBySide: true,
                wordWrap: 'on',
                diffWordWrap: 'on',
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                fontFamily: "'Atkinson Hyperlegible Mono Variable', ui-monospace, monospace",
                fontSize: 13,
              }}
            />
          ) : null}
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button onClick={onClose}>Decide later</Button>
          <Button onClick={() => void decide(() => reloadFromDisk(path))} data-testid="compare-use-disk">
            Use the disk version
          </Button>
          <Button variant="primary" onClick={() => void decide(() => overwriteOnDisk(path))} data-testid="compare-keep-mine">
            Keep mine and save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
