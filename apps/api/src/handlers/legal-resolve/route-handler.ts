import type { TSchema } from "@sinclair/typebox";
import { t } from "elysia";

import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS } from "@/api/lib/api-handlers";
import { tPublicLawCountry } from "@/api/lib/legal-search/public-law-country";
import {
  permissiveRouteSchema,
  validatePostAuth,
} from "@/api/lib/permissive-route-schema";

import type { authorizeLegalResolveRequest } from "./authorization";

type LegalResolveAuthorization = Awaited<
  ReturnType<typeof authorizeLegalResolveRequest>
>;

export type GetLegalResolveAuthorization = (
  request: Request,
) => Promise<LegalResolveAuthorization>;

export type LegalResolveRouteResponse =
  | LegalResolveResponse
  | { error: "access_unavailable" | "missing_scope" | "not_entitled" };

const legalResolveResponseSchema = {
  200: t.Any(),
  403: t.Object({
    error: t.Union([t.Literal("missing_scope"), t.Literal("not_entitled")]),
  }),
  429: t.String(),
  503: t.Object({ error: t.Literal("access_unavailable") }),
};

const legalResolveParamsSchema = t.Object({
  country: tPublicLawCountry,
});

export const legalResolveBaseConfig = {
  accountAccess: ACCOUNT_ACCESS.sandbox,
  contentDelivery: {
    type: "none",
    reason: "Returns public-law protocol responses to an authorized client.",
  },
  mcp: { type: "internal", reason: "auth_plumbing" },
  params: permissiveRouteSchema({ keys: ["country"] }),
  response: legalResolveResponseSchema,
} satisfies TokenHandlerConfig;

type PrepareLegalResolveRequestOptions<TQuery extends TSchema> = {
  getAuthorization: GetLegalResolveAuthorization;
  params: unknown;
  query: unknown;
  querySchema: TQuery;
  request: Request;
  set: { status?: number | string };
};

export const prepareLegalResolveRequest = async <TQuery extends TSchema>({
  getAuthorization,
  params,
  query,
  querySchema,
  request,
  set,
}: PrepareLegalResolveRequestOptions<TQuery>) => {
  const authorization = await getAuthorization(request);
  if (authorization.status !== 200) {
    set.status = authorization.status;
    return { status: "rejected" as const, body: authorization.body };
  }
  const validatedParams = validatePostAuth(legalResolveParamsSchema, params);
  if (!validatedParams.ok) {
    return { status: "invalid" as const, message: validatedParams.message };
  }
  const validatedQuery = validatePostAuth(querySchema, query);
  if (!validatedQuery.ok) {
    return { status: "invalid" as const, message: validatedQuery.message };
  }
  return {
    status: "ready" as const,
    authorization,
    params: validatedParams.value,
    query: validatedQuery.value,
  };
};
