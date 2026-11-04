import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TableSkeleton } from '@/components/common/states';
import { ComparePage } from '@/features/ml/compare-page';

export const metadata: Metadata = { title: 'Compare runs' };

export default function Page() {
  return (
    <Suspense fallback={<TableSkeleton rows={6} />}>
      <ComparePage />
    </Suspense>
  );
}
