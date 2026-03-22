export interface BlockData {
  id: string;
  order: number;
  pageId: string;
  title: string;
  type: "link" | "header" | "text";
  url?: string;
  visible: boolean;
}

export type DropPosition = "above" | "below" | null;
