import { Result } from "better-result";

import { requestAbsence, requestAbsenceBodySchema } from "@/api/lib/absences";
import { createSafeRootHandler } from "@/api/lib/api-handlers";

const request = createSafeRootHandler(
  {
    description:
      "Request your own absence in the active organization using a local startDate and endDate (end-exclusive), IANA timezoneId, kind, and full or half-day coverage. Half-day requests cover one day and specify morning or afternoon. Returns id, requested status, and version; use the current version when changing the request. Capacity is reported as days, without assumed work minutes.",
    permissions: { timeEntry: ["create"] },
    access: "write",
    mcp: { type: "capability", reason: "billing_admin" },
    body: requestAbsenceBodySchema,
  },
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    const payload = yield* Result.await(
      requestAbsence({
        safeDb,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        body,
        recordAuditEvent,
      }),
    );
    return Result.ok(payload);
  },
);
export default request;
