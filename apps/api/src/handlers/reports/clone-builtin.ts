/**
 * Clone a built-in report template into the caller's organization so it can be
 * customized in Template Studio.
 *
 * The built-in report layouts ship with the deployment and are only visible in
 * the export picker; there is no org row to open or edit. "Customize" copies the
 * built-in's DOCX into a stored `report`-kind template via the shared
 * `createStoredTemplate` recipe, passing the registry manifest verbatim so the
 * clone's manifest is byte-faithful to the built-in's — including per-item AI
 * fields under array paths (`contracts.summary`) that a discovery merge would
 * fold into the array root and drop. The clone therefore fills identically to
 * the built-in, appears in the picker alongside it, and opens in the Templates
 * knowledge section.
 *
 * Ownership is server-validated: `organizationId` from the session, never the
 * body; the body only names which built-in to clone.
 */

import { Result } from "better-result";
import { t } from "elysia";

import { getBuiltinReportTemplate } from "@/api/handlers/reports/builtin-templates";
import { createStoredTemplate } from "@/api/handlers/templates/create-template-service";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { workspace: ["read"], template: ["create"] },
  mcp: { type: "capability", reason: "reporting_export" },
  params: workspaceParams({}),
  body: t.Object({ key: t.String({ minLength: 1 }) }),
} satisfies HandlerConfig;

const cloneBuiltinReportTemplate = createSafeHandler(
  config,
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    const builtin = getBuiltinReportTemplate(body.key);
    if (!builtin) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Unknown built-in report template: ${body.key}`,
        }),
      );
    }

    const organizationId = session.activeOrganizationId;

    // Name collision: the built-in ships with a fixed name, so a second clone
    // would duplicate it. Append " (copy)" when a same-named template already
    // exists (RLS scopes the lookup to the caller's organization). The table
    // has no name-uniqueness constraint, so further clones are allowed to share
    // the "(copy)" name rather than growing an unbounded numbering scheme.
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.templates.findFirst({
          where: { name: { eq: builtin.name } },
          columns: { id: true },
        }),
      ),
    );
    const name = existing ? `${builtin.name} (copy)` : builtin.name;

    const buffer = await builtin.loadBuffer();

    const created = yield* createStoredTemplate({
      safeDb,
      organizationId,
      userId: user.id,
      buffer,
      name,
      fileName: `${name}.docx`,
      // Verbatim: the registry manifest is the fill contract; re-discovering it
      // from the DOCX would drop the per-item `contracts.summary` AI field.
      manifest: builtin.manifest,
      kind: "report",
      recordAuditEvent,
    });
    if (Result.isError(created)) {
      return Result.err(created.error);
    }

    return Result.ok({ templateId: created.value.id });
  },
);

export default cloneBuiltinReportTemplate;
