import type { Priority } from '../store';

const LABELS: Record<Priority, string> = { LOW: 'Low', NORMAL: 'Normal', HIGH: 'High', URGENT: 'Urgent' };

export function priorityLabel(priority: Priority): string {
  return LABELS[priority];
}

export function formatDueDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
