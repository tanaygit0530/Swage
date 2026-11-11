import { useState } from 'react';
import { createTask } from '../api';

export function TaskForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState('');

  async function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    await createTask(title);
    setTitle('');
    onCreated();
  }

  return (
    <form onSubmit={submit}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task" />
      <button type="submit">Add</button>
    </form>
  );
}
