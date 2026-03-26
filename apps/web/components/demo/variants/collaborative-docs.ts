import type { SchemaDefinition } from "@stratasync/core";

import type { SeedRow } from "../types";

export const collaborativeDocsSchema: SchemaDefinition = {
  models: {
    Block: {
      fields: {
        content: {},
        createdAt: {},
        id: {},
        order: {},
        type: {},
        updatedAt: {},
      },
      loadStrategy: "instant",
    },
  },
};

export const collaborativeDocsSeedRows: SeedRow[] = [
  {
    data: {
      content: "Project Brief",
      createdAt: 1,
      id: "seed-1",
      order: 1,
      type: "heading",
      updatedAt: 1,
    },
    modelName: "Block",
  },
  {
    data: {
      content: "This document outlines the key goals and milestones for Q1.",
      createdAt: 2,
      id: "seed-2",
      order: 2,
      type: "paragraph",
      updatedAt: 2,
    },
    modelName: "Block",
  },
  {
    data: {
      content: "Goals",
      createdAt: 3,
      id: "seed-3",
      order: 3,
      type: "heading",
      updatedAt: 3,
    },
    modelName: "Block",
  },
  {
    data: {
      content: "Launch beta by March",
      createdAt: 4,
      id: "seed-4",
      order: 4,
      type: "bullet",
      updatedAt: 4,
    },
    modelName: "Block",
  },
  {
    data: {
      content: "Onboard 50 users",
      createdAt: 5,
      id: "seed-5",
      order: 5,
      type: "bullet",
      updatedAt: 5,
    },
    modelName: "Block",
  },
];
