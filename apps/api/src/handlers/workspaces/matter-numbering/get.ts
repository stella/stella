import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
} from "@/api/lib/matter-reference";
import { projectionPayload } from "@/api/lib/projection-totality";

/** The two settings the answer carries, and nothing else of the row. */
const matterNumberingSchema = v.strictObject({
  matterNumberPattern: v.string(),
  matterNumberPadding: v.number(),
});

const config = {
  contract: "patch",
  description:
    "Read the organization's matter-number convention: the pattern new " +
    "matter numbers follow and the padding of its counter, so a number " +
    "typed for a matter can be checked against it " +
    "(`matchesMatterReferencePattern`). An organization that never set one " +
    "gets the defaults.",
  // Whoever can open a matter sees its number; the convention behind it is
  // no more private. Changing it stays an organization settings write.
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "organization_management",
    consumesServices: false,
  },
  access: "read",
} satisfies HandlerConfig;

/**
 * `GET /v1/workspaces/matter-numbering`: the two settings a matter-number
 * hint needs, and nothing else of the organization's settings.
 */
const readMatterNumbering = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const row = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: session.activeOrganizationId } },
          columns: { matterNumberPattern: true, matterNumberPadding: true },
        }),
      ),
    );
    return Result.ok(
      projectionPayload(matterNumberingSchema, {
        matterNumberPattern:
          row?.matterNumberPattern ?? DEFAULT_MATTER_NUMBER_PATTERN,
        matterNumberPadding:
          row?.matterNumberPadding ?? DEFAULT_MATTER_NUMBER_PADDING,
      }),
    );
  },
);

export default readMatterNumbering;
