import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
      <p className="text-sm font-medium text-primary">404</p>
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="text-muted-foreground">
        This page doesn’t exist, or you don’t have access to it.
      </p>
      <Button asChild variant="outline">
        <Link href="/">Back to ModelOps Cloud</Link>
      </Button>
    </main>
  );
}
