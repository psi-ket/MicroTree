import { Group, Panel, Separator, type GroupProps, type PanelProps, type SeparatorProps } from 'react-resizable-panels';
import { cn } from '../cn';

export { useDefaultLayout, usePanelRef, type PanelImperativeHandle } from 'react-resizable-panels';

export function ResizableGroup({ className, ...props }: GroupProps) {
  return <Group className={cn('h-full w-full', className)} {...props} />;
}

export function ResizablePanel({ className, ...props }: PanelProps) {
  return <Panel className={cn('min-h-0 min-w-0', className)} {...props} />;
}

/** A 1px rule with a wider invisible hit area that lights up in the accent colour while dragging. */
export function ResizableHandle({
  className,
  orientation = 'vertical',
  ...props
}: SeparatorProps & { orientation?: 'vertical' | 'horizontal' }) {
  return (
    <Separator
      className={cn(
        'group relative shrink-0 bg-rule outline-none transition-colors data-[separator=active]:bg-accent data-[separator=hover]:bg-rule-strong focus-visible:bg-accent',
        orientation === 'vertical'
          ? 'w-px after:absolute after:inset-y-0 after:-left-[3px] after:w-[7px]'
          : 'h-px after:absolute after:inset-x-0 after:-top-[3px] after:h-[7px]',
        className,
      )}
      {...props}
    />
  );
}
