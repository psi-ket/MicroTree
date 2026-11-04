import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useResolvedTheme } from '../../lib/theme';

/**
 * A read-only LaTeX diff. As in the assistant's review dialog, the models are
 * kept by the widget and disposed only after it has let go of them (Monaco
 * throws when a model is disposed before the diff widget is reset).
 */
export function SafeDiff({ original, modified, path, sideBySide = true }: { original: string; modified: string; path: string; sideBySide?: boolean }) {
  const theme = useResolvedTheme();
  const ref = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  useEffect(
    () => () => {
      const model = ref.current?.getModel();
      ref.current = null;
      setTimeout(() => {
        model?.original.dispose();
        model?.modified.dispose();
      }, 0);
    },
    [],
  );
  const onMount: DiffOnMount = (d) => {
    ref.current = d;
  };
  return (
    <DiffEditor
      original={original}
      modified={modified}
      originalModelPath={`${path}#a`}
      modifiedModelPath={`${path}#b`}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={onMount}
      language="latex"
      theme={theme === 'dark' ? 'rs-dark' : 'rs-light'}
      options={{ readOnly: true, renderSideBySide: sideBySide, minimap: { enabled: false }, wordWrap: 'on' }}
    />
  );
}
