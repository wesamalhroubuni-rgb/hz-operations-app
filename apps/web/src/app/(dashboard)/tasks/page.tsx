import type { Metadata } from 'next';

import { TaskListPage } from '@/components/tasks/task-list-page';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('pages.tasks.title') };

export default function TasksPage() {
  return <TaskListPage />;
}
