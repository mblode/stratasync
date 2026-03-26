import type { SchemaDefinition } from "@stratasync/core";

import type { SeedRow } from "../types";

export const designToolsSchema: SchemaDefinition = {
  models: {
    Layer: {
      fields: {
        color: {},
        createdAt: {},
        height: {},
        id: {},
        name: {},
        order: {},
        type: {},
        updatedAt: {},
        visible: {},
        width: {},
        x: {},
        y: {},
      },
      loadStrategy: "instant",
    },
  },
};

export const designToolsSeedRows: SeedRow[] = [
  {
    data: {
      color: "#1F2937",
      createdAt: 1,
      height: 60,
      id: "seed-1",
      name: "Header",
      order: 1,
      type: "frame",
      updatedAt: 1,
      visible: true,
      width: 130,
      x: 12,
      y: 12,
    },
    modelName: "Layer",
  },
  {
    data: {
      color: "#2E6F40",
      createdAt: 2,
      height: 100,
      id: "seed-2",
      name: "Hero Background",
      order: 2,
      type: "rectangle",
      updatedAt: 2,
      visible: true,
      width: 110,
      x: 160,
      y: 12,
    },
    modelName: "Layer",
  },
  {
    data: {
      color: "#1F2937",
      createdAt: 3,
      height: 36,
      id: "seed-3",
      name: "Heading",
      order: 3,
      type: "text",
      updatedAt: 3,
      visible: true,
      width: 100,
      x: 24,
      y: 90,
    },
    modelName: "Layer",
  },
  {
    data: {
      color: "#3B82F6",
      createdAt: 4,
      height: 50,
      id: "seed-4",
      name: "Logo Mark",
      order: 4,
      type: "ellipse",
      updatedAt: 4,
      visible: true,
      width: 50,
      x: 230,
      y: 130,
    },
    modelName: "Layer",
  },
  {
    data: {
      color: "#F59E0B",
      createdAt: 5,
      height: 32,
      id: "seed-5",
      name: "CTA Button",
      order: 5,
      type: "rectangle",
      updatedAt: 5,
      visible: true,
      width: 90,
      x: 50,
      y: 150,
    },
    modelName: "Layer",
  },
];
