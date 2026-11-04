import type { Metadata } from 'next';
import { AcceptInvite } from '@/features/org/accept-invite';

export const metadata: Metadata = { title: 'Accept invitation' };

export default function Page() {
  return <AcceptInvite />;
}
