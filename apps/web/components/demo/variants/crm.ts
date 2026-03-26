import type { SchemaDefinition } from "@stratasync/core";

import type { SeedRow } from "../types";

export const crmSchema: SchemaDefinition = {
  models: {
    Contact: {
      fields: {
        company: {},
        createdAt: {},
        dealValue: {},
        id: {},
        name: {},
        stage: {},
        updatedAt: {},
      },
      loadStrategy: "instant",
    },
  },
};

export const crmSeedRows: SeedRow[] = [
  {
    data: {
      company: "Acme Corp",
      createdAt: 1,
      dealValue: 12_000,
      id: "seed-1",
      name: "Sarah Chen",
      stage: "qualified",
      updatedAt: 1,
    },
    modelName: "Contact",
  },
  {
    data: {
      company: "Globex Inc",
      createdAt: 2,
      dealValue: 45_500,
      id: "seed-2",
      name: "James Wilson",
      stage: "proposal",
      updatedAt: 2,
    },
    modelName: "Contact",
  },
  {
    data: {
      company: "Initech",
      createdAt: 3,
      dealValue: 128_000,
      id: "seed-3",
      name: "Maria Garcia",
      stage: "closed",
      updatedAt: 3,
    },
    modelName: "Contact",
  },
  {
    data: {
      company: "Umbrella Co",
      createdAt: 4,
      dealValue: 8200,
      id: "seed-4",
      name: "Alex Kim",
      stage: "lead",
      updatedAt: 4,
    },
    modelName: "Contact",
  },
];
