import Elysia, { t } from "elysia";

import { VERIFICATION_CODE_PATTERN } from "@stll/api-contract";

import { resolveVerificationCodeAuth } from "@/api/handlers/verify/resolve-auth";
import { authMacro } from "@/api/lib/auth";

/**
 * Authenticated resolution: `/v1/verify/:code` → the referenced document
 * version (matter, document, reference, version numbers), or 404 when no
 * version in the caller's organization carries the code. Called by the
 * frontend's `/verify/:code` page after the user is logged in.
 */
export const verifyAuthRoute = new Elysia({ prefix: "/verify" })
  .use(authMacro)
  .guard({ validateAuth: true })
  .get(
    "/:code",
    async (ctx) =>
      await resolveVerificationCodeAuth(
        ctx.params.code,
        ctx.session.activeOrganizationId,
        ctx.scopedDb,
      ),
    {
      params: t.Object({
        code: t.String({ pattern: VERIFICATION_CODE_PATTERN }),
      }),
    },
  );
