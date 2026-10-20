import type { workspaceViewTemplates } from "@/api/db/schema";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

// Layouts and copied property definitions can carry matter content. Personal
// names and timestamps do not expose those copied definitions.
export const toPersonalViewTemplateResponse = (
  row: typeof workspaceViewTemplates.$inferSelect,
) => ({
  id: row.id,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

type WorkspaceViewTemplateRow = typeof workspaceViewTemplates.$inferSelect;
type PersonalViewTemplateResponse = ReturnType<
  typeof toPersonalViewTemplateResponse
>;

// Columns intentionally left out of the account export.
const UNEXPORTED_VIEW_TEMPLATE_COLUMNS = [
  // Tenant id: internal routing, not data the user provided.
  "organizationId",
  // The exporting account itself; every exported template is its own.
  "userId",
  // Layouts and copied property definitions can carry matter content
  // (see the comment on toPersonalViewTemplateResponse).
  "layout",
  "templateProperties",
] as const satisfies readonly (keyof WorkspaceViewTemplateRow)[];

// Totality guard, bidirectional: every schema column must be exported or
// explicitly excused above, and the export cannot carry a field that traces
// back to no real column.
type MissingExportedViewTemplateColumn = UnprojectedColumns<
  WorkspaceViewTemplateRow,
  PersonalViewTemplateResponse,
  (typeof UNEXPORTED_VIEW_TEMPLATE_COLUMNS)[number]
>;
type UnexpectedExportedViewTemplateColumn = UnbackedProjectionKeys<
  WorkspaceViewTemplateRow,
  PersonalViewTemplateResponse,
  (typeof UNEXPORTED_VIEW_TEMPLATE_COLUMNS)[number]
>;

true satisfies MissingExportedViewTemplateColumn extends never ? true : never;
true satisfies UnexpectedExportedViewTemplateColumn extends never
  ? true
  : never;
