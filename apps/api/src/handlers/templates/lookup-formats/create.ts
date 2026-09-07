import { panic, Result } from "better-result";
import { t } from "elysia";

import { templateLookupFormats } from "@/api/db/schema";
import {
  FORMAT_LIMITS,
  toResponse,
} from "@/api/handlers/templates/lookup-formats/projection";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { LOOKUP_REGISTRIES } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Save a reusable company specification format for colleagues in the active organization.",
  permissions: { template: ["create"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  body: t.Object(
    {
      registry: t.UnionEnum(LOOKUP_REGISTRIES),
      name: t.String({ minLength: 1, maxLength: FORMAT_LIMITS.name }),
      format: t.String({ minLength: 1, maxLength: FORMAT_LIMITS.format }),
    },
    { additionalProperties: false },
  ),
} satisfies HandlerConfig;

const createLookupFormat = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const name = body.name.trim();
    if (!name || !body.format.trim()) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Name and format must not be empty",
        }),
      );
    }
    const row = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .insert(templateLookupFormats)
          .values({
            organizationId: session.activeOrganizationId,
            registry: body.registry,
            name,
            format: body.format,
          })
          .returning();
        const created =
          rows.at(0) ?? panic("Lookup format insert returned no row");
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE_LOOKUP_FORMAT,
          resourceId: created.id,
          changes: {
            created: { old: null, new: { registry: created.registry } },
          },
        });
        return created;
      }),
    );
    return Result.ok(toResponse(row));
  },
);

export default createLookupFormat;
