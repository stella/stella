import Elysia, { t } from "elysia";

import { resolveVerificationCodeAuth } from "@/api/handlers/verify/resolve-auth";
import { authMacro } from "@/api/lib/auth";

const VCODE_PATTERN = "^[abcdefghjkmnpqrstuvwxyz23456789]{10}$";

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
        code: t.String({ pattern: VCODE_PATTERN }),
      }),
    },
  );
