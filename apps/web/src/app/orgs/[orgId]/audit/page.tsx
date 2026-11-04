import type { Metadata } from 'next';
import { AuditPage } from '@/features/audit/audit-page';

export const metadata: Metadata = { title: 'Audit log' };

export default function Page() {
  return <AuditPage />;
}
