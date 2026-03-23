import { assignOptionalFields } from "../utils/assign.js";
import type {
  FieldDefinition,
  ModelDefinition,
  ModelMetadata,
  ModelRegistrySnapshot,
  PropertyMetadata,
  RelationDefinition,
  RelationKind,
  SchemaDefinition,
} from "./types.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isRegistrySnapshot = (
  value: unknown
): value is ModelRegistrySnapshot => {
  if (!isObject(value)) {
    return false;
  }
  const { models } = value;
  if (!isObject(models)) {
    return false;
  }
  const entries = Object.values(models);
  if (entries.length === 0) {
    return true;
  }
  return entries.every(
    (entry) =>
      isObject(entry) &&
      "meta" in entry &&
      "properties" in entry &&
      isObject(entry.meta) &&
      isObject(entry.properties)
  );
};

const normalizeRelationKind = (
  kind?: RelationKind
): PropertyMetadata["type"] => {
  switch (kind) {
    case "belongsTo":
    case "reference":
    case "referenceModel": {
      return "referenceModel";
    }
    case "hasMany":
    case "referenceCollection": {
      return "referenceCollection";
    }
    case "manyToMany":
    case "referenceArray": {
      return "referenceArray";
    }
    case "backReference": {
      return "backReference";
    }
    default: {
      return "referenceModel";
    }
  }
};

const toModelMetadata = (
  name: string,
  model: ModelDefinition
): ModelMetadata => {
  const metadata: ModelMetadata = {
    loadStrategy: model.loadStrategy ?? "instant",
    name,
  };

  assignOptionalFields(metadata, model, [
    "partialLoadMode",
    "usedForPartialIndexes",
    "schemaVersion",
    "tableName",
    "groupKey",
  ]);

  if (model.primaryKey && model.primaryKey !== "id") {
    metadata.primaryKey = model.primaryKey;
  }

  if ((model.indexes?.length ?? 0) > 0) {
    metadata.indexes = model.indexes;
  }

  return metadata;
};

const toPropertyFromField = (field: FieldDefinition): PropertyMetadata => {
  const meta: PropertyMetadata = {
    type: field.ephemeral ? "ephemeralProperty" : "property",
  };

  assignOptionalFields(meta, field, [
    "lazy",
    "serializer",
    "indexed",
    "nullable",
  ]);

  return meta;
};

const toPropertyFromRelation = (
  relation: RelationDefinition
): PropertyMetadata => {
  const kind = relation.kind ?? relation.type;
  const meta: PropertyMetadata = {
    referenceModel: relation.model,
    type: normalizeRelationKind(kind),
  };

  assignOptionalFields(meta, relation, [
    "inverseProperty",
    "foreignKey",
    "through",
    "lazy",
    "serializer",
    "indexed",
    "nullable",
  ]);

  return meta;
};

const ensurePrimaryField = (
  fields: Record<string, FieldDefinition>,
  primaryKey: string
): Record<string, FieldDefinition> => {
  if (fields[primaryKey]) {
    return fields;
  }
  return {
    ...fields,
    [primaryKey]: {},
  };
};

export const schemaToSnapshot = (
  schema: SchemaDefinition
): ModelRegistrySnapshot => {
  const models: ModelRegistrySnapshot["models"] = {};

  for (const [name, model] of Object.entries(schema.models)) {
    const primaryKey = model.primaryKey ?? "id";
    const fields = ensurePrimaryField(model.fields ?? {}, primaryKey);
    const relations = model.relations ?? {};

    const properties: Record<string, PropertyMetadata> = {};

    for (const [fieldName, field] of Object.entries(fields)) {
      properties[fieldName] = toPropertyFromField(field);
    }

    for (const [relationName, relation] of Object.entries(relations)) {
      properties[relationName] = toPropertyFromRelation(relation);
    }

    models[name] = {
      meta: toModelMetadata(name, model),
      properties,
    };
  }

  return { models };
};

const relationKindFromProperty = (
  type: PropertyMetadata["type"]
): RelationKind | undefined => {
  switch (type) {
    case "referenceModel": {
      return "referenceModel";
    }
    case "referenceCollection": {
      return "referenceCollection";
    }
    case "backReference": {
      return "backReference";
    }
    case "referenceArray": {
      return "referenceArray";
    }
    case "reference": {
      return "reference";
    }
    default: {
      return undefined;
    }
  }
};

export const snapshotToSchemaDefinition = (
  snapshot: ModelRegistrySnapshot
): SchemaDefinition => {
  const models: Record<string, ModelDefinition> = {};

  for (const [name, entry] of Object.entries(snapshot.models)) {
    const fields: Record<string, FieldDefinition> = {};
    const relations: Record<string, RelationDefinition> = {};

    for (const [propertyName, property] of Object.entries(entry.properties)) {
      if (
        property.type === "property" ||
        property.type === "ephemeralProperty" ||
        property.type === "reference"
      ) {
        const field: FieldDefinition = {};
        assignOptionalFields(field, property, [
          "indexed",
          "nullable",
          "serializer",
          "lazy",
        ]);
        if (property.type === "ephemeralProperty") {
          field.ephemeral = true;
        }
        fields[propertyName] = field;
        continue;
      }

      const kind = relationKindFromProperty(property.type);
      if (!(kind && property.referenceModel)) {
        continue;
      }

      const relation: RelationDefinition = {
        kind,
        model: property.referenceModel,
      };
      assignOptionalFields(relation, property, [
        "inverseProperty",
        "foreignKey",
        "through",
        "lazy",
        "serializer",
        "indexed",
        "nullable",
      ]);
      relations[propertyName] = relation;
    }

    const model: ModelDefinition = {
      fields,
      loadStrategy: entry.meta.loadStrategy,
      name,
      relations,
    };

    assignOptionalFields(model, entry.meta, [
      "partialLoadMode",
      "usedForPartialIndexes",
      "schemaVersion",
      "tableName",
      "primaryKey",
      "groupKey",
      "indexes",
    ]);

    models[name] = model;
  }

  return { models };
};
