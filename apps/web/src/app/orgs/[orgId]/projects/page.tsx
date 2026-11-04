import type { Metadata } from 'next';
import { ProjectsPage } from '@/features/projects/projects-page';

export const metadata: Metadata = { title: 'Projects' };

export default function Page() {
  return <ProjectsPage />;
}
