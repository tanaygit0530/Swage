import type { Task } from './store';

const BASE_URL = '/api';

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

export function fetchTasks(): Promise<Task[]> {
  return request<Task[]>('/tasks');
}

export function createTask(title: string): Promise<Task> {
  return request<Task>('/tasks', { method: 'POST', body: JSON.stringify({ title }) });
}
