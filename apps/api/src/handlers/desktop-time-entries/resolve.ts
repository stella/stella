import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import {
  DESKTOP_MATTER_ACCESS,
  desktopMatterResolveQuerySchema,
  desktopMatterResolveResponseSchema,
} from "@stll/api-contract/desktop-time-entries";
import { WORKSPACE_STATUS } from "@stll/api-contract/workspace-status";

import { workspaces } from "@/api/db/schema";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";

import { authorizeDesktopTimeEntries } from "./authorize";
import {
  matterCandidateSignals,
  selectMatterCandidates,
  toMatterCandidate,
} from "./matter-candidate-projection";

/**
 * Matters the desktop's records name by id, read under the member's own
 * access with the shortlist's projection. A matter the member cannot open,
 * or that is no longer active, answers `inaccessible` without a name, so
 * "not on the shortlist" and "no access" stay distinguishable.
 */
export const createDesktopMatterResolveEndpoint = (
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      query: desktopMatterResolveQuerySchema,
      response: safePublicHandlerResponseSchemasWithStatusText(
        desktopMatterResolveResponseSchema,
      ),
    },
    async function* ({ request, query: { id } }) {
      const account = yield* Result.await(
        authorizeDesktopTimeEntries(request, authorizeAccount),
      );
      const ids = (typeof id === "string" ? [id] : id).map((matterId) =>
        matterId.toLowerCase(),
      );
      const signals = matterCandidateSignals(account.userId);
      const rows = yield* Result.await(
        account.safeDb(async (tx) =>
          selectMatterCandidates(tx, signals)
            .where(
              and(
                eq(workspaces.organizationId, account.organizationId),
                eq(workspaces.status, WORKSPACE_STATUS.active),
                inArray(workspaces.id, ids),
              ),
            )
            .limit(ids.length),
        ),
      );
      const accessible = new Map(
        rows.map((row) => [String(row.id), toMatterCandidate(row)]),
      );
      return Result.ok({
        matters: ids.map((matterId) => {
          const matter = accessible.get(matterId);
          return matter === undefined
            ? { type: DESKTOP_MATTER_ACCESS[1], id: matterId }
            : { type: DESKTOP_MATTER_ACCESS[0], matter };
        }),
      });
    },
  );
export default createDesktopMatterResolveEndpoint();
