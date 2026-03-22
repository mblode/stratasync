"use client";

import {
  useConnectionState,
  useIsOffline,
  useQuery,
  useSyncClientInstance,
} from "@stratasync/react";
import { observer } from "mobx-react-lite";
import { useState, type FormEvent } from "react";

import { DEV_GROUP_ID } from "@/lib/sync/config";
import type { Todo } from "@/lib/sync/models/todo";

const formatTimestamp = (value: number) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

const ExamplePage = observer(function ExamplePage() {
  const client = useSyncClientInstance();
  const { backlog, error, lastSyncId, status } = useConnectionState();
  const isOffline = useIsOffline();
  const { data: todos, isLoading } = useQuery<Todo>("Todo", {
    orderBy: (a, b) => b.createdAt - a.createdAt,
  });

  const [draft, setDraft] = useState("");
  const [mutationError, setMutationError] = useState<string | null>(null);

  const completedCount = todos.filter((todo) => todo.completed).length;
  const statusTone = error
    ? "error"
    : isOffline
      ? "warning"
      : backlog > 0
        ? "warning"
        : "ok";

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = draft.trim();

    if (!title) {
      return;
    }

    setMutationError(null);

    try {
      await client.create("Todo", {
        completed: false,
        createdAt: Date.now(),
        groupId: DEV_GROUP_ID,
        title,
      });
      setDraft("");
    } catch (caughtError) {
      setMutationError(
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to create todo."
      );
    }
  };

  const toggleTodo = async (todo: Todo) => {
    setMutationError(null);

    try {
      await client.update("Todo", todo.id, {
        completed: !todo.completed,
      });
    } catch (caughtError) {
      setMutationError(
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to update todo."
      );
    }
  };

  const removeTodo = async (id: string) => {
    setMutationError(null);

    try {
      await client.delete("Todo", id);
    } catch (caughtError) {
      setMutationError(
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to delete todo."
      );
    }
  };

  return (
    <main className="app-shell">
      <section className="hero-card">
        <span className="eyebrow">Offline first + realtime</span>

        <div className="hero-grid">
          <div className="hero-copy">
            <h1>Todo sync, without a demo-shaped gap.</h1>
            <p>
              This starter shows the full Strata Sync loop: IndexedDB-backed
              local reads, optimistic writes, server sequencing, and live
              updates over WebSocket.
            </p>

            <div className="hero-stats">
              <div className="stat-card">
                <span>Total todos</span>
                <strong>{todos.length}</strong>
              </div>

              <div className="stat-card">
                <span>Completed</span>
                <strong>{completedCount}</strong>
              </div>

              <div className="stat-card">
                <span>Outbox backlog</span>
                <strong>{backlog}</strong>
              </div>
            </div>
          </div>

          <div className="status-stack">
            <div className="status-pill" data-tone={statusTone}>
              <div>
                <div className="status-label">Sync state</div>
                <strong>{isOffline ? "offline" : status}</strong>
                <div className="status-meta">
                  Last sync id: <code>{String(lastSyncId)}</code>
                </div>
              </div>

              <div>
                <div className="status-label">Queue</div>
                <strong>{backlog > 0 ? `${backlog} pending` : "clear"}</strong>
              </div>
            </div>

            <div className="status-pill" data-tone={error ? "error" : "ok"}>
              <div>
                <div className="status-label">Transport</div>
                <strong>{error ? "attention needed" : "healthy"}</strong>
                <div className="status-meta">
                  {error
                    ? error.message
                    : "Client writes stay local first and reconcile on sync."}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Todo list</h2>
            <p>Open this page in two tabs, or stop the API and keep writing.</p>
          </div>
        </div>

        {mutationError ? (
          <div className="error-banner">{mutationError}</div>
        ) : null}

        <form
          className="todo-form"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <input
            className="todo-input"
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            placeholder="Add a todo..."
            value={draft}
          />

          <button className="primary-button" type="submit">
            Create todo
          </button>
        </form>

        <div className="todo-list">
          {isLoading && todos.length === 0 ? (
            <div className="empty-state">Bootstrapping local state...</div>
          ) : null}

          {!isLoading && todos.length === 0 ? (
            <div className="empty-state">
              Nothing synced yet. Create a todo, refresh, then open a second
              tab.
            </div>
          ) : null}

          {todos.map((todo) => (
            <article
              className="todo-item"
              data-completed={todo.completed}
              key={todo.id}
            >
              <input
                aria-label={`Toggle ${todo.title}`}
                checked={todo.completed}
                className="todo-checkbox"
                onChange={() => {
                  void toggleTodo(todo);
                }}
                type="checkbox"
              />

              <div className="todo-copy">
                <span className="todo-title">{todo.title}</span>
                <span className="todo-subtitle">
                  Group <code>{todo.groupId}</code> • Created{" "}
                  {formatTimestamp(todo.createdAt)}
                </span>
              </div>

              <button
                className="ghost-button"
                onClick={() => {
                  void removeTodo(todo.id);
                }}
                type="button"
              >
                Delete
              </button>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
});

export default ExamplePage;
