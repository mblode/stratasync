import {
  useConnectionState,
  useIsOffline,
  useQuery,
  useSyncClientInstance,
} from "@stratasync/react";
import { observer } from "mobx-react-lite";
import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useState } from "react";

import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import { DEV_GROUP_ID } from "@/lib/sync/config.js";
import type { Todo } from "@/lib/sync/models/todo.js";

const TodoItem = observer(
  ({
    onRemove,
    onToggle,
    todo,
  }: {
    onRemove: (id: string) => void;
    onToggle: (todo: Todo) => void;
    todo: Todo;
  }) => {
    const handleToggle = useCallback(() => {
      onToggle(todo);
    }, [onToggle, todo]);

    const handleRemove = useCallback(() => {
      onRemove(todo.id);
    }, [onRemove, todo.id]);

    return (
      <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
        <Checkbox
          checked={todo.completed}
          onCheckedChange={handleToggle}
          aria-label={`Toggle ${todo.title}`}
        />
        <span
          className={`flex-1 text-sm ${todo.completed ? "text-muted line-through" : ""}`}
        >
          {todo.title}
        </span>
        <Button variant="ghost" size="sm" onClick={handleRemove}>
          Delete
        </Button>
      </div>
    );
  }
);

const ExamplePage = observer(function ExamplePage() {
  const client = useSyncClientInstance();
  const { backlog, error, status } = useConnectionState();
  const isOffline = useIsOffline();
  const { data: todos, isLoading } = useQuery<Todo>("Todo", {
    orderBy: (a, b) => b.createdAt - a.createdAt,
  });

  const [draft, setDraft] = useState("");
  const [mutationError, setMutationError] = useState<string | null>(null);

  const handleDraftChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setDraft(event.currentTarget.value);
    },
    []
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
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
    },
    [client, draft]
  );

  const handleToggle = useCallback(
    async (todo: Todo) => {
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
    },
    [client]
  );

  const handleRemove = useCallback(
    async (id: string) => {
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
    },
    [client]
  );

  const getStatusVariant = () => {
    if (error) {
      return "destructive" as const;
    }
    if (isOffline || backlog > 0) {
      return "outline" as const;
    }
    return "secondary" as const;
  };

  const getStatusText = () => {
    if (error) {
      return "error";
    }
    if (isOffline) {
      return "offline";
    }
    if (backlog > 0) {
      return `${backlog} pending`;
    }
    return status;
  };

  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Todos</h1>
        <Badge variant={getStatusVariant()}>{getStatusText()}</Badge>
      </div>

      {mutationError ? (
        <div className="mb-4 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {mutationError}
        </div>
      ) : null}

      <form className="mb-6 flex gap-2" onSubmit={handleSubmit}>
        <Input
          className="flex-1"
          onChange={handleDraftChange}
          placeholder="What needs to be done?"
          value={draft}
        />
        <Button type="submit">Add</Button>
      </form>

      <div className="space-y-2">
        {isLoading && todos.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">Loading...</p>
        ) : null}

        {!isLoading && todos.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">
            No todos yet. Create one above.
          </p>
        ) : null}

        {todos.map((todo) => (
          <TodoItem
            key={todo.id}
            onRemove={handleRemove}
            onToggle={handleToggle}
            todo={todo}
          />
        ))}
      </div>
    </main>
  );
});

export default ExamplePage;
