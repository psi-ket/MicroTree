import { Command } from 'cmdk';
import { useMemo } from 'react';
import type { FileTreeNode } from '@research-studio/shared-types';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { Kbd } from '@research-studio/ui';
import { useTree } from '../../lib/queries';
import { useLayout } from '../../stores/layout';
import { openFile } from '../workspace/actions';

export interface PaletteCommand {
  id: string;
  label: string;
  shortcut?: string;
  run: () => void;
}

function flatten(node: FileTreeNode | undefined): FileTreeNode[] {
  if (!node) return [];
  return (node.children ?? []).flatMap((c) => (c.type === 'file' ? [c] : flatten(c)));
}

export function CommandPalette({ projectId, commands }: { projectId: string; commands: PaletteCommand[] }) {
  const { palette, openPalette } = useLayout();
  const { data: tree } = useTree(projectId);
  const files = useMemo(() => flatten(tree), [tree]);
  const close = () => openPalette(null);

  return (
    <DialogPrimitive.Root open={palette !== null} onOpenChange={(open) => !open && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgb(10_14_22/0.35)]" />
        <DialogPrimitive.Content
          aria-label={palette === 'files' ? 'Go to file' : 'Commands'}
          className="fixed left-1/2 top-[12vh] z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-lg border border-rule bg-panel shadow-float"
        >
          <DialogPrimitive.Title className="sr-only">{palette === 'files' ? 'Go to file' : 'Commands'}</DialogPrimitive.Title>
          <Command loop label="Command palette" className="flex flex-col">
            <Command.Input
              autoFocus
              placeholder={palette === 'files' ? 'Type a file name…' : 'Type a command…'}
              className="h-11 border-b border-rule bg-transparent px-4 text-[14px] text-ink outline-none placeholder:text-ink-faint"
            />
            <Command.List className="max-h-[50vh] overflow-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-ui text-ink-faint">No matches.</Command.Empty>
              {palette === 'files' ? (
                <Command.Group>
                  {files.map((f) => (
                    <Command.Item
                      key={f.path}
                      value={f.path}
                      onSelect={() => {
                        close();
                        void openFile(f.path);
                      }}
                      className="flex h-8 cursor-default items-center gap-2 rounded px-2.5 text-ui text-ink data-[selected=true]:bg-accent-soft"
                    >
                      <span>{f.name}</span>
                      <span className="truncate text-2xs text-ink-faint">{f.path}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : (
                <Command.Group>
                  {commands.map((c) => (
                    <Command.Item
                      key={c.id}
                      value={c.label}
                      onSelect={() => {
                        close();
                        c.run();
                      }}
                      className="flex h-8 cursor-default items-center rounded px-2.5 text-ui text-ink data-[selected=true]:bg-accent-soft"
                    >
                      {c.label}
                      {c.shortcut ? <Kbd className="ml-auto">{c.shortcut}</Kbd> : null}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
