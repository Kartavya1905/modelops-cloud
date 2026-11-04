'use client';

import { XIcon } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

/** Accessible modal: focus trap, Escape to close, labelled by its title (Radix Dialog). */
export function DialogContent({ className, children, ...props }: ComponentProps<typeof D.Content>) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <D.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border bg-popover p-6 text-popover-foreground shadow-lg data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      >
        {children}
        <D.Close className="absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
          <XIcon className="size-4" aria-hidden />
          <span className="sr-only">Close</span>
        </D.Close>
      </D.Content>
    </D.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('grid gap-1.5 pr-6', className)} {...props} />;
}
export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}
export function DialogTitle({ className, ...props }: ComponentProps<typeof D.Title>) {
  return <D.Title className={cn('text-lg leading-none font-semibold', className)} {...props} />;
}
export function DialogDescription({ className, ...props }: ComponentProps<typeof D.Description>) {
  return <D.Description className={cn('text-sm text-muted-foreground', className)} {...props} />;
}
