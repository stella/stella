import { Result } from "better-result";
import * as v from "valibot";

import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";

import type { TokenHandlerConfig, VerifyCaller } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { tPublicLawCountry } from "@/api/lib/legal-search/public-law-country";

import type { authorizeLegalResolveRequest } from "./authorization";

type LegalResolveAuthorization = Awaited<
  ReturnType<typeof authorizeLegalResolveRequest>
>;

export type GetLegalResolveAuthorization = (
  request: Request,
) => Promise<LegalResolveAuthorization>;

type LegalResolveRefusal = Exclude<
  LegalResolveAuthorization,
  { status: 200 }
>["body"]["error"];

/** Told the answer a resolve request produced, so the route can audit its outcome. */
export type LegalResolveResolved = (
  request: Request,
  response: LegalResolveResponse,
) => void;

/** What a verified legal resolve credential proves: the caller and its admitted read. */
export type LegalResolveCaller = Pick<
  Extract<LegalResolveAuthorization, { status: 200 }>,
  "admission" | "session"
>;

const legalResolveResponseSchema = {
  200: v.unknown(),
  401: v.object({ error: v.literal("unauthorized") }),
  403: v.object({ error: v.literal("missing_scope") }),
  429: v.string(),
  503: v.object({ error: v.literal("access_unavailable") }),
};

export const legalResolveBaseConfig = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  contentDelivery: {
    type: "none",
    reason: "Returns public-law protocol responses to an authorized client.",
  },
  mcp: { type: "internal", reason: "auth_plumbing" },
  params: v.object({ country: tPublicLawCountry }),
  response: legalResolveResponseSchema,
} satisfies TokenHandlerConfig;

/**
 * The refusal message never reaches the client: the declared response schema
 * for each refusal status keeps only its OAuth-style `error`.
 */
const REFUSAL_MESSAGES: Readonly<Record<LegalResolveRefusal, string>> = {
  unauthorized: "Unauthorized",
  missing_scope: "Missing scope",
  access_unavailable: "Access unavailable",
};

/** A legal resolve route's caller: the bearer credential, verified once per request. */
export const verifyLegalResolveCaller =
  (
    getAuthorization: GetLegalResolveAuthorization,
  ): VerifyCaller<LegalResolveCaller> =>
  async ({ request }) => {
    const authorization = await getAuthorization(request);
    if (authorization.status !== 200) {
      return Result.err(
        new HandlerError({
          status: authorization.status,
          message: REFUSAL_MESSAGES[authorization.body.error],
          error: authorization.body.error,
        }),
      );
    }
    return Result.ok({
      admission: authorization.admission,
      session: authorization.session,
    });
  };
