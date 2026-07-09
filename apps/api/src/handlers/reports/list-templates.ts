/**
 * Report template picker surface.
 *
 * Returns the deployment built-in report templates plus this organization's
 * stored `report`-kind templates (RLS-scoped). The set is bounded by
 * `LIMITS.templatesCount`, so a plain array is returned (no pagination), like
 * the document-type taxonomy. Minimal fields only: the picker needs a key/id
 * and a display name.
 */

import { Result } from "better-result";

import { listBuiltinReportTemplates } from "@/api/handlers/reports/builtin-templates";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { workspaceParams } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "reporting_export" },
  params: workspaceParams({}),
} satisfies HandlerConfig;

const listReportTemplates = createSafeHandler(
  config,
  async function* ({ safeDb }) {
    const stored = yield* Result.await(
      safeDb((tx) =>
        tx.query.templates.findMany({
          where: { kind: { eq: "report" } },
          columns: { id: true, name: true },
          orderBy: { name: "asc" },
          limit: LIMITS.templatesCount,
        }),
      ),
    );

    return Result.ok({
      builtins: listBuiltinReportTemplates(),
      stored: stored.map((template) => ({
        id: template.id,
        name: template.name,
      })),
    });
  },
);

export default listReportTemplates;
