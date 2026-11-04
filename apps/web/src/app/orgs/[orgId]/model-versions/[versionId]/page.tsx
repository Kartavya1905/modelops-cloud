import type { Metadata } from 'next';
import { ModelVersionPage } from '@/features/ml/model-pages';

export const metadata: Metadata = { title: 'Model version' };

export default function Page() {
  return <ModelVersionPage />;
}
