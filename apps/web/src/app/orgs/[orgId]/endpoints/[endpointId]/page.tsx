import type { Metadata } from 'next';
import { EndpointPage } from '@/features/deployments/endpoint-page';

export const metadata: Metadata = { title: 'Endpoint' };

export default function Page() {
  return <EndpointPage />;
}
