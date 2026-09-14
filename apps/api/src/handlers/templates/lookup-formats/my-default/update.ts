import { Result } from "better-result";
import { t } from "elysia";

import { setLookupFormatUserDefault } from "@/api/handlers/templates/lookup-formats/set-user-default";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { LOOKUP_REGISTRIES } from "@/api/lib/docx/types";

const config = {
  description:
    "Choose or clear your own default company specification format for a business registry, overriding the organization's default for you alone.",
  // permissions-exempt: the write reaches nothing but the caller's own
  // preference row (user + organization RLS). Every member who may open the
  // format picker may choose their own default, so workspace:read is the
  // grant, not a floor under a missing one.
  permissions: { workspace: ["read"] },
  access: "write",
  mcp: { type: "capability", reason: "template_authoring_ui" },
  body: t.Object(
    {
      registry: t.UnionEnum(LOOKUP_REGISTRIES),
      formatId: t.Union([tSafeId("templateLookupFormat"), t.Null()]),
    },
    { additionalProperties: false },
  ),
} satisfies HandlerConfig;

const setMyDefaultLookupFormat = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body }) {
    yield* yield* Result.await(
      safeDb(
        async (tx) =>
          await setLookupFormatUserDefault({
            tx,
            organizationId: session.activeOrganizationId,
            userId: user.id,
            registry: body.registry,
            formatId: body.formatId,
          }),
      ),
    );
    return Result.ok({ success: true });
  },
);

export default setMyDefaultLookupFormat;
