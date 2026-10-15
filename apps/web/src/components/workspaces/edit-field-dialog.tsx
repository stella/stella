import type { WorkspaceField } from "@/lib/types";

export type EditableFieldContent = Extract<
  WorkspaceField["content"],
  { type: "text" | "single-select" | "multi-select" | "date" | "int" }
>;
