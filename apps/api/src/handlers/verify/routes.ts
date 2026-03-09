import Elysia, { t } from "elysia";

import { resolveVerificationCode } from "@/api/handlers/verify/resolve";
import { resolveVerificationCodeAuth } from "@/api/handlers/verify/resolve-auth";
import { authMacro } from "@/api/lib/auth";

// biome-ignore lint/security/noSecrets: character set, not a secret
const VCODE_PATTERN = "^[abcdefghjkmnpqrstuvwxyz23456789]{10}$";

/**
 * Public deep link: `/v/:code` → 302 to frontend `/verify/:code`.
 * No DB lookup; no internal IDs exposed in the redirect.
 */
export const verifyRoute = new Elysia({ prefix: "/v" }).get(
  "/:code",
  (ctx) => resolveVerificationCode(ctx.params.code),
  {
    params: t.Object({
      code: t.String({ pattern: VCODE_PATTERN }),
    }),
  },
);

/**
 * Authenticated resolution: `/v1/verify/:code` → entity location.
 * Called by the frontend after the user is logged in.
 */
export const verifyAuthRoute = new Elysia({ prefix: "/verify" })
  .use(authMacro)
  .guard({ validateAuth: true })
  .get(
    "/:code",
    (ctx) =>
      resolveVerificationCodeAuth(
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
