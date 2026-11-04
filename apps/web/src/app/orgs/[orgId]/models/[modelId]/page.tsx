import type { Metadata } from 'next';
import { ModelPage } from '@/features/ml/model-pages';

export const metadata: Metadata = { title: 'Model' };

export default function Page() {
  return <ModelPage />;
}
