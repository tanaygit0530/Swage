import { sortByDueDate, visibleTasks, type TaskState } from '../store';
import { formatDueDate, priorityLabel } from '../utils/format';

export function TaskList({ state }: { state: TaskState }) {
  const tasks = sortByDueDate(visibleTasks(state));
  return (
    <ul className="task-list">
      {tasks.map((task) => (
        <li key={task.id} className={task.done ? 'done' : ''}>
          <span>{task.title}</span>
          <span className="priority">{priorityLabel(task.priority)}</span>
          {task.due && <time>{formatDueDate(task.due)}</time>}
        </li>
      ))}
    </ul>
  );
}
