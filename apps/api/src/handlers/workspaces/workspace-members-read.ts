import type { ScopedDb } from "@/api/db/safe-db";
import type { workspaceMembers } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type WorkspaceMemberRow = typeof workspaceMembers.$inferSelect;

// Columns intentionally not sent to the client. A new schema column must
// either be added to `WORKSPACE_MEMBER_COLUMNS` below or added here with a
// reason, or the totality check further down fails to typecheck.
const UNPROJECTED_WORKSPACE_MEMBER_COLUMNS = [
  // The route is already scoped to one workspace via the workspaceId
  // parameter; restating it per-member would be redundant.
  "workspaceId",
] as const satisfies readonly (keyof WorkspaceMemberRow)[];

// The exact `columns:` selection passed to `findMany` below. Reused there
// so the selection and the totality guard can never drift apart. The
// nested `user` profile (see `with:` below) is a separate, intentionally
// narrow picker-style projection (for display only), not "the resource"
// this guard covers.
const WORKSPACE_MEMBER_COLUMNS = {
  id: true,
  userId: true,
  createdAt: true,
} as const;

// Totality guard, bidirectional: every schema column must be projected onto
// the response or explicitly excused above, and the projection cannot carry
// a field that traces back to no real column.
type MissingProjectedWorkspaceMemberColumn = UnprojectedColumns<
  WorkspaceMemberRow,
  typeof WORKSPACE_MEMBER_COLUMNS,
  (typeof UNPROJECTED_WORKSPACE_MEMBER_COLUMNS)[number]
>;
type UnexpectedProjectedWorkspaceMemberColumn = UnbackedProjectionKeys<
  WorkspaceMemberRow,
  typeof WORKSPACE_MEMBER_COLUMNS,
  (typeof UNPROJECTED_WORKSPACE_MEMBER_COLUMNS)[number]
>;

true satisfies MissingProjectedWorkspaceMemberColumn extends never
  ? true
  : never;
true satisfies UnexpectedProjectedWorkspaceMemberColumn extends never
  ? true
  : never;

type ReadWorkspaceMembersHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
};

export const readWorkspaceMembersHandler = async ({
  scopedDb,
  workspaceId,
}: ReadWorkspaceMembersHandlerProps) =>
  await scopedDb((tx) =>
    tx.query.workspaceMembers.findMany({
      where: { workspaceId: { eq: workspaceId } },
      limit: LIMITS.workspaceMembersCount,
      columns: WORKSPACE_MEMBER_COLUMNS,
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
    }),
  );
