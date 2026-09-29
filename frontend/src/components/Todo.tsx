import { useEffect, useState } from 'react'
import { fetchTodos, createTodo, updateTodo, deleteTodo, type Todo } from '../api'
import { PlusIcon, TrashIcon } from '../icons'

export function TodoPage() {
  const [todos, setTodos] = useState<Todo[] | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      setTodos(await fetchTodos())
    } catch (err) {
      setError((err as Error).message)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    await createTodo(title.trim())
    setTitle('')
    load()
  }

  async function toggle(todo: Todo) {
    await updateTodo(todo.id, { done: !todo.done })
    load()
  }

  async function remove(id: number) {
    await deleteTodo(id)
    load()
  }

  if (error) return <div className="error">{error}</div>
  if (!todos) return <div className="loading">Chargement…</div>

  const pending = todos.filter((t) => !t.done)
  const done = todos.filter((t) => t.done)

  return (
    <div className="todo-page">
      <div className="glass-card">
        <h2 className="section-title">Todo</h2>
        <form onSubmit={handleAdd} className="todo-add-row">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nouvelle tâche…" />
          <button type="submit" className="icon-button" aria-label="Ajouter">
            <PlusIcon size={16} />
          </button>
        </form>
      </div>

      <div className="glass-card">
        {pending.length === 0 && done.length === 0 && <p className="pie-empty">Aucune tâche pour l'instant.</p>}

        <ul className="todo-list">
          {pending.map((t) => (
            <li key={t.id} className="todo-row">
              <button className="habit-check" onClick={() => toggle(t)} aria-label="Marquer comme fait" />
              <span className="todo-title">{t.title}</span>
              <button className="icon-action-button icon-action-button--danger" onClick={() => remove(t.id)} aria-label="Supprimer la tâche">
                <TrashIcon size={16} />
              </button>
            </li>
          ))}
          {done.map((t) => (
            <li key={t.id} className="todo-row todo-row--done">
              <button className="habit-check habit-check--done" onClick={() => toggle(t)} aria-label="Décocher" />
              <span className="todo-title">{t.title}</span>
              <button className="icon-action-button icon-action-button--danger" onClick={() => remove(t.id)} aria-label="Supprimer la tâche">
                <TrashIcon size={16} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
