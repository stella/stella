import { Result } from "better-result";

import { rootDb } from "@/api/db/root";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { probeDiagnostics } from "@/api/lib/health/probe-diagnostics";

const config = {
  permissions: { admin: ["read"] },
  mcp: { type: "internal", reason: "provider_secret" },
} satisfies HandlerConfig;

const adminDiagnostics = createSafeRootHandler(
  config,
  async function* ({ user }) {
    const userRow = await rootDb.query.user.findFirst({
      where: (userTable, { eq }) => eq(userTable.id, user.id),
    });

    if (!userRow || !userRow.isSystemAdmin) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Forbidden: Administrative access required",
        }),
      );
    }

    const diagnostics = await probeDiagnostics();
    return Result.ok(diagnostics);
  },
);

export default adminDiagnostics;
export { config, adminDiagnostics as handler };
