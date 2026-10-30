import type { Metadata } from 'next';

import { TaskDetailPage } from '@/components/tasks/task-detail-page';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('pages.taskDetail.title') };

export default async function TaskPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  return <TaskDetailPage id={id} />;
}
