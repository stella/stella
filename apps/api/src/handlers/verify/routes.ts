import * as v from "valibot";

import { VERIFICATION_CODE_PATTERN } from "@stll/api-contract";

import { resolveVerificationCodeAuth } from "@/api/handlers/verify/resolve-auth";
import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";

const VERIFICATION_CODE = new RegExp(VERIFICATION_CODE_PATTERN, "u");

/**
 * Authenticated resolution: `/v1/verify/:code` to the referenced document
 * version (matter, document, reference, version numbers), or 404 when no
 * version in the caller's organization carries the code. Called by the
 * frontend's `/verify/:code` page after the user is logged in.
 */
const resolveVerificationCode = defineEndpoint.member(
  {
    params: v.object({
      code: v.pipe(v.string(), v.regex(VERIFICATION_CODE)),
    }),
  },
  async ({ params, session, scopedDb }) =>
    await resolveVerificationCodeAuth(
      params.code,
      session.activeOrganizationId,
      scopedDb,
    ),
);

export const verifyAuthRoute = routes(
  { "/:code": { GET: resolveVerificationCode } },
  { prefix: "/verify" },
);
