import {
  ContextMenu as ContextMenuPrimitive,
  Dialog as DialogPrimitive,
  DropdownMenu as DropdownMenuPrimitive,
  Tooltip as TooltipPrimitive,
} from 'radix-ui';
import { X } from 'lucide-react';
import type { ComponentPropsWithoutRef, HTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';
import { Kbd } from './primitives';

// ------------------------------------------------------------------ dialog

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgb(10_14_22/0.45)] backdrop-blur-[1px] data-[state=open]:animate-[rs-fade_120ms_ease-out]" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-[18vh] z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 rounded-lg border border-rule bg-panel p-5 shadow-float outline-none data-[state=open]:animate-[rs-rise_140ms_ease-out]',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute right-3 top-3 rounded p-1 text-ink-faint hover:bg-sunken hover:text-ink"
          aria-label="Close"
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ className, ...props }: ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('font-display text-[19px] leading-6 text-ink', className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('mt-1 text-ui text-ink-muted', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-5 flex justify-end gap-2', className)} {...props} />;
}

// ------------------------------------------------------------------ menus

const menuContent =
  'z-50 min-w-44 overflow-hidden rounded-md border border-rule bg-raised p-1 text-ui text-ink shadow-float data-[state=open]:animate-[rs-fade_90ms_ease-out]';
const menuItem =
  'relative flex h-7 cursor-default select-none items-center gap-2 rounded px-2 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent-soft data-[highlighted]:text-ink [&_svg]:size-[14px] [&_svg]:text-ink-muted';

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content sideOffset={sideOffset} className={cn(menuContent, className)} {...props} />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  danger,
  shortcut,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { danger?: boolean; shortcut?: string }) {
  return (
    <DropdownMenuPrimitive.Item className={cn(menuItem, danger && 'text-danger [&_svg]:text-danger', className)} {...props}>
      {children}
      {shortcut ? <Kbd className="ml-auto">{shortcut}</Kbd> : null}
    </DropdownMenuPrimitive.Item>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>) {
  return <DropdownMenuPrimitive.Label className={cn('px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-faint', className)} {...props} />;
}

export function DropdownMenuSeparator() {
  return <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-rule" />;
}

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

export function ContextMenuContent({ className, ...props }: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content className={cn(menuContent, className)} {...props} />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  danger,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & { danger?: boolean }) {
  return <ContextMenuPrimitive.Item className={cn(menuItem, danger && 'text-danger [&_svg]:text-danger', className)} {...props} />;
}

export function ContextMenuSeparator() {
  return <ContextMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-rule" />;
}

// ------------------------------------------------------------------ tooltip

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({
  content,
  shortcut,
  children,
  side = 'bottom',
}: {
  content: ReactNode;
  shortcut?: string;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <TooltipPrimitive.Root delayDuration={350}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 flex items-center gap-2 rounded border border-rule bg-raised px-2 py-1 text-xs text-ink shadow-float"
        >
          {content}
          {shortcut ? <Kbd>{shortcut}</Kbd> : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
