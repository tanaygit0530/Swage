export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export interface Task {
  id: number;
  title: string;
  priority: Priority;
  due?: string;
  done: boolean;
}

export interface TaskState {
  tasks: Task[];
  filter: 'all' | 'open' | 'done';
}

export function visibleTasks(state: TaskState): Task[] {
  return state.tasks.filter((t) =>
    state.filter === 'all' ? true : state.filter === 'done' ? t.done : !t.done,
  );
}

export function sortByDueDate(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
}
