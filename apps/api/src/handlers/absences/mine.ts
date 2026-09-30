import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";

import { absenceListQuerySchema, listAbsencePage } from "./list-query";

const mine = createSafeRootHandler(
  {
    description:
      "List your own absence requests in the active organization, including decisions and current versions. Dates are local and end-exclusive; capacity is reported as days, without assumed work minutes. Follow nextCursor for the next bounded page.",
    permissions: { timeEntry: ["read"] },
    access: "read",
    mcp: { type: "capability", reason: "billing_admin" },
    query: absenceListQuerySchema,
  },
  async function* ({ safeDb, session, user, query }) {
    const page = yield* Result.await(
      listAbsencePage({
        safeDb,
        organizationId: session.activeOrganizationId,
        selection: { type: "mine", userId: user.id },
        query,
      }),
    );
    return Result.ok(page);
  },
);
export default mine;
