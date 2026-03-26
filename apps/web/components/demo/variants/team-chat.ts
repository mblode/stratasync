import type { SchemaDefinition } from "@stratasync/core";

import type { SeedRow } from "../types";

export const teamChatSchema: SchemaDefinition = {
  models: {
    Message: {
      fields: {
        createdAt: {},
        id: {},
        sender: {},
        senderColor: {},
        text: {},
      },
      loadStrategy: "instant",
    },
  },
};

export const teamChatSeedRows: SeedRow[] = [
  {
    data: {
      createdAt: 1,
      id: "seed-1",
      sender: "Alice",
      senderColor: "#3B82F6",
      text: "Has anyone tested the new sync flow?",
    },
    modelName: "Message",
  },
  {
    data: {
      createdAt: 2,
      id: "seed-2",
      sender: "Bob",
      senderColor: "#8B5CF6",
      text: "Yes, works great offline!",
    },
    modelName: "Message",
  },
  {
    data: {
      createdAt: 3,
      id: "seed-3",
      sender: "Alice",
      senderColor: "#3B82F6",
      text: "Perfect. Pushing to staging now.",
    },
    modelName: "Message",
  },
  {
    data: {
      createdAt: 4,
      id: "seed-4",
      sender: "Carol",
      senderColor: "#10B981",
      text: "I can help with the docs update.",
    },
    modelName: "Message",
  },
];
