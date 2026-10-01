import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { DESKTOP_REGISTRY_PERMISSION } from "@/api/lib/business-registries/desktop/config";
import { createDesktopLinkGrant } from "@/api/lib/business-registries/desktop/link-grants";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";

export default createSafeRootHandler(
  {
    permissions: DESKTOP_REGISTRY_PERMISSION,
    mcp: { type: "internal", reason: "auth_plumbing" },
    body: t.Object(
      {
        correlationId: t.String({ format: "uuid" }),
        verifierHash: t.String({
          minLength: 64,
          maxLength: 64,
          pattern: "^[a-f0-9]{64}$",
        }),
      },
      { additionalProperties: false },
    ),
  },
  async function* ({ user, session, body, set }) {
    set.headers[CACHE_CONTROL_HEADER] = PRIVATE_CACHE_CONTROL;
    return Result.ok(
      yield* Result.await(
        createDesktopLinkGrant({
          ...body,
          userId: user.id,
          organizationId: session.activeOrganizationId,
        }),
      ),
    );
  },
);
