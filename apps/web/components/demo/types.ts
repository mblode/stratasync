import type { SchemaDefinition } from "@stratasync/core";
import type { ComponentType } from "react";

import type { DemoTransport } from "./demo-transport";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface SyncAnimation {
  id: string;
  direction: "left" | "right";
}

export interface SeedRow {
  modelName: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Demo variant system
// ---------------------------------------------------------------------------

export interface DemoPanelProps {
  label: string;
  transport: DemoTransport;
}

export interface DemoVariant {
  key: string;
  title: string;
  icon: ComponentType<{ className?: string }>;
  description: string;
  schema: SchemaDefinition;
  seedRows: SeedRow[];
  panelComponent: ComponentType<DemoPanelProps>;
  latencyMs?: number;
}

// ---------------------------------------------------------------------------
// Model types per demo variant
// ---------------------------------------------------------------------------

export interface Todo {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  updatedAt?: number;
}

export interface Issue {
  id: string;
  title: string;
  status: "backlog" | "cancelled" | "done" | "in_progress" | "todo";
  priority: "high" | "low" | "medium" | "none" | "urgent";
  assigneeInitials: string;
  assigneeColor: string;
  issueNumber: number;
  createdAt: number;
  updatedAt: number;
}

export interface Block {
  id: string;
  type: "bullet" | "heading" | "paragraph";
  content: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface Layer {
  id: string;
  name: string;
  type: "ellipse" | "frame" | "rectangle" | "text";
  color: string;
  visible: boolean;
  order: number;
  x: number;
  y: number;
  width: number;
  height: number;
  createdAt: number;
  updatedAt: number;
}

export interface Contact {
  id: string;
  name: string;
  company: string;
  dealValue: number;
  stage: "closed" | "lead" | "proposal" | "qualified";
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  text: string;
  sender: string;
  senderColor: string;
  createdAt: number;
}
