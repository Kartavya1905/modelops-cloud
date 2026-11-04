import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * Native <select>, styled to match. Native controls give the best keyboard and screen-reader
 * behaviour for short option lists (roles), with zero JavaScript.
 */
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-9 rounded-md border border-input bg-card px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
