/**
 * Small shadcn/ui-style primitives (Input, Label, Textarea, Card, Badge, Alert, Skeleton, Table).
 * Written from shadcn's patterns and owned by this repo, like shadcn-generated components.
 */
import { cva, type VariantProps } from 'class-variance-authority';
import { Label as LabelPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const field =
  'w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(field, 'h-9', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(field, 'min-h-20 py-2', className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none',
        className,
      )}
      {...props}
    />
  );
}

/** Label + control + help/error text, wired up for screen readers. */
export function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('rounded-xl border bg-card text-card-foreground shadow-sm', className)}
      {...props}
    />
  );
}
export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('grid gap-1.5 p-6 pb-0', className)} {...props} />;
}
export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-lg leading-none font-semibold', className)} {...props} />;
}
export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}
export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-6', className)} {...props} />;
}

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/12 text-primary',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'text-foreground',
        success: 'border-transparent bg-success/15 text-success',
        warning: 'border-transparent bg-warning/15 text-warning',
        destructive: 'border-transparent bg-destructive/15 text-destructive',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export function Alert({
  className,
  variant = 'default',
  ...props
}: ComponentProps<'div'> & { variant?: 'default' | 'destructive' }) {
  return (
    <div
      role="alert"
      className={cn(
        'relative grid gap-1 rounded-lg border px-4 py-3 text-sm',
        variant === 'destructive' && 'border-destructive/40 bg-destructive/5 text-destructive',
        className,
      )}
      {...props}
    />
  );
}

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  );
}
export function THead(props: ComponentProps<'thead'>) {
  return <thead className="[&_tr]:border-b" {...props} />;
}
export function TBody(props: ComponentProps<'tbody'>) {
  return <tbody className="[&_tr:last-child]:border-0" {...props} />;
}
export function Tr({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr className={cn('border-b transition-colors hover:bg-muted/50', className)} {...props} />
  );
}
export function Th({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'h-10 px-3 text-left align-middle font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
export function Td({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-3 py-3 align-middle', className)} {...props} />;
}
