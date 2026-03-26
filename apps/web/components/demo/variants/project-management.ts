import type { SchemaDefinition } from "@stratasync/core";

import type { SeedRow } from "../types";

export const projectManagementSchema: SchemaDefinition = {
  models: {
    Issue: {
      fields: {
        assigneeColor: {},
        assigneeInitials: {},
        createdAt: {},
        id: {},
        issueNumber: {},
        priority: {},
        status: {},
        title: {},
        updatedAt: {},
      },
      loadStrategy: "instant",
    },
  },
};

export const projectManagementSeedRows: SeedRow[] = [
  {
    data: {
      assigneeColor: "#3B82F6",
      assigneeInitials: "MB",
      createdAt: 1,
      id: "seed-1",
      issueNumber: 1,
      priority: "none",
      status: "done",
      title: "Set up CI pipeline",
      updatedAt: 1,
    },
    modelName: "Issue",
  },
  {
    data: {
      assigneeColor: "#8B5CF6",
      assigneeInitials: "AK",
      createdAt: 2,
      id: "seed-2",
      issueNumber: 2,
      priority: "urgent",
      status: "in_progress",
      title: "Build sync engine",
      updatedAt: 2,
    },
    modelName: "Issue",
  },
  {
    data: {
      assigneeColor: "#10B981",
      assigneeInitials: "JS",
      createdAt: 3,
      id: "seed-3",
      issueNumber: 3,
      priority: "medium",
      status: "todo",
      title: "Write API docs",
      updatedAt: 3,
    },
    modelName: "Issue",
  },
  {
    data: {
      assigneeColor: "#3B82F6",
      assigneeInitials: "MB",
      createdAt: 4,
      id: "seed-4",
      issueNumber: 4,
      priority: "low",
      status: "cancelled",
      title: "Add dark mode",
      updatedAt: 4,
    },
    modelName: "Issue",
  },
  {
    data: {
      assigneeColor: "#8B5CF6",
      assigneeInitials: "AK",
      createdAt: 5,
      id: "seed-5",
      issueNumber: 5,
      priority: "high",
      status: "backlog",
      title: "Set up monitoring",
      updatedAt: 5,
    },
    modelName: "Issue",
  },
];
