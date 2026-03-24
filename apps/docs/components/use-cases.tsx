import {
  CheckSquare,
  FileText,
  KanbanSquare,
  MessageSquare,
  PenTool,
  Users,
} from "lucide-react";

const useCases = [
  {
    description:
      "A Linear-style issue tracker with server-sequenced sync and offline writes.",
    icon: KanbanSquare,
    title: "Project management",
  },
  {
    description:
      "A Notion-like editor with Yjs CRDT for real-time multi-user editing.",
    icon: FileText,
    title: "Collaborative docs",
  },
  {
    description:
      "A Figma-like canvas with shared state, live cursors, and undo/redo.",
    icon: PenTool,
    title: "Design tool",
  },
  {
    description:
      "A to-do app that works offline and syncs instantly on reconnect.",
    icon: CheckSquare,
    title: "Task lists",
  },
  {
    description:
      "Companies, contacts, and deals with relational schemas and field-level conflict resolution.",
    icon: Users,
    title: "CRM",
  },
  {
    description:
      "Instant messaging with optimistic writes and background sync.",
    icon: MessageSquare,
    title: "Team chat",
  },
];

export const UseCases = () => (
  <section className="not-prose grid gap-x-6 gap-y-8 sm:grid-cols-2 md:grid-cols-3">
    {useCases.map((useCase) => (
      <div key={useCase.title} className="flex flex-col gap-2">
        <useCase.icon className="size-5 text-fd-muted-foreground" />
        <h3 className="text-fd-foreground text-sm font-semibold">
          {useCase.title}
        </h3>
        <p className="text-fd-muted-foreground text-sm leading-relaxed">
          {useCase.description}
        </p>
      </div>
    ))}
  </section>
);
