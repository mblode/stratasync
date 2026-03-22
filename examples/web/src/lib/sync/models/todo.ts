import { ClientModel, Model, Property } from "@stratasync/core";

@ClientModel("Todo", { loadStrategy: "instant" })
export class Todo extends Model {
  @Property() declare id: string;
  @Property() declare title: string;
  @Property() declare completed: boolean;
  @Property() declare createdAt: number;
  @Property() declare groupId: string;
}
