export interface Todo {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  updatedAt?: number;
}

export interface SyncAnimation {
  id: string;
  direction: "left" | "right";
}
