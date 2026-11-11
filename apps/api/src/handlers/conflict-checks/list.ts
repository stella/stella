import { Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { conflictChecks } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  conflictCheckCursor,
  listConflictChecks,
} from "@/api/lib/conflict-check/operation";
import { paginationCursorSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

const config = {
  contract: "patch",
  description:
    "List the conflict checks the caller may see, newest first: their own, " +
    "every check for an owner or administrator, and checks run for a " +
    "matter the caller can open.",
  permissions: { conflictCheck: ["run"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "contact_directory",
    consumesServices: false,
  },
  query: v.object({
    cursor: v.exactOptional(paginationCursorSchema()),
    limit: v.exactOptional(
      numberFromString(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(LIMITS.conflictChecksPageSizeMax),
        ),
      ),
    ),
  }),
} satisfies HandlerConfig;

const listConflictCheckPage = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session }) {
    const cursor =
      query.cursor === undefined
        ? undefined
        : conflictCheckCursor.decode(query.cursor);
    if (cursor === null) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "invalid_cursor",
          message: "Invalid cursor",
        }),
      );
    }
    const page = yield* Result.await(
      listConflictChecks({
        safeDb,
        organizationId: session.activeOrganizationId,
        limit: normalizeTenantPageLimit(
          query.limit ?? LIMITS.conflictChecksPageSizeDefault,
        ),
        after:
          cursor === undefined
            ? undefined
            : conflictCheckCursor.keysetAfter({
                cursor,
                idColumn: conflictChecks.id,
                direction: "descending",
              }),
      }),
    );
    return Result.ok(page);
  },
);

export default listConflictCheckPage;
