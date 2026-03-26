import {
  BubbleTextIcon,
  ColorPaletteIcon,
  ContactsIcon,
  KanbanViewIcon,
  PageEditIcon,
  TodosIcon,
} from "blode-icons-react";

import { ChatPanel } from "../panels/chat-panel";
import { CrmPanel } from "../panels/crm-panel";
import { DesignPanel } from "../panels/design-panel";
import { DocsPanel } from "../panels/docs-panel";
import { ProjectPanel } from "../panels/project-panel";
import { TaskListPanel } from "../panels/task-list-panel";
import type { DemoVariant } from "../types";
import {
  collaborativeDocsSchema,
  collaborativeDocsSeedRows,
} from "./collaborative-docs";
import { crmSchema, crmSeedRows } from "./crm";
import { designToolsSchema, designToolsSeedRows } from "./design-tools";
import {
  projectManagementSchema,
  projectManagementSeedRows,
} from "./project-management";
import { taskListSchema, taskListSeedRows } from "./task-list";
import { teamChatSchema, teamChatSeedRows } from "./team-chat";

export const variants: DemoVariant[] = [
  {
    description:
      "Tick off items and reorder lists instantly, even in aeroplane mode.",
    icon: TodosIcon,
    key: "task-lists",
    panelComponent: TaskListPanel,
    schema: taskListSchema,
    seedRows: taskListSeedRows,
    title: "Task lists",
  },
  {
    description:
      "Drag-and-drop boards that work offline. Changes sync the moment you're back.",
    icon: KanbanViewIcon,
    key: "project-management",
    panelComponent: ProjectPanel,
    schema: projectManagementSchema,
    seedRows: projectManagementSeedRows,
    title: "Project management",
  },
  {
    description:
      "Real-time co-editing with Yjs. Multiple cursors, no conflicts.",
    icon: PageEditIcon,
    key: "collaborative-docs",
    panelComponent: DocsPanel,
    schema: collaborativeDocsSchema,
    seedRows: collaborativeDocsSeedRows,
    title: "Collaborative docs",
  },
  {
    description:
      "Shared canvases with zero latency. Every action is local-first.",
    icon: ColorPaletteIcon,
    key: "design-tools",
    latencyMs: 0,
    panelComponent: DesignPanel,
    schema: designToolsSchema,
    seedRows: designToolsSeedRows,
    title: "Design tools",
  },
  {
    description:
      "Track contacts and deals with instant reads. Stay productive offline.",
    icon: ContactsIcon,
    key: "crm",
    panelComponent: CrmPanel,
    schema: crmSchema,
    seedRows: crmSeedRows,
    title: "CRM",
  },
  {
    description:
      "Messages queue locally and deliver on reconnect. No waiting for the server.",
    icon: BubbleTextIcon,
    key: "team-chat",
    panelComponent: ChatPanel,
    schema: teamChatSchema,
    seedRows: teamChatSeedRows,
    title: "Team chat",
  },
];
