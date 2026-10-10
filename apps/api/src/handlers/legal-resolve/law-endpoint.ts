import { Result } from "better-result";
import { t } from "elysia";

import type {
  SafeHandlerGenerator,
  TokenHandlerConfig,
} from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { permissiveRouteSchema } from "@/api/lib/permissive-route-schema";

import { authorizeLegalResolveRequestOnce } from "./authorization";
import { resolveLawCitation } from "./law";
import {
  type GetLegalResolveAuthorization,
  legalResolveBaseConfig,
  type LegalResolveRouteResponse,
  prepareLegalResolveRequest,
} from "./route-handler";

const strictQuery = t.Object({
  citation: t.Optional(t.String({ maxLength: 512 })),
  collection: t.Optional(t.String({ maxLength: 32 })),
  year: t.Optional(tDefaultVarchar),
  number: t.Optional(t.String({ maxLength: 16 })),
  section: t.Optional(t.String({ maxLength: 32 })),
  asOf: t.Optional(t.String({ format: "date" })),
});

type LawRouteHandlerOptions = {
  getAuthorization: GetLegalResolveAuthorization;
  resolve?: typeof resolveLawCitation;
};

const lawConfig = {
  ...legalResolveBaseConfig,
  query: permissiveRouteSchema({
    keys: ["citation", "collection", "year", "number", "section", "asOf"],
  }),
} satisfies TokenHandlerConfig;

// The generator is written inline so the config types its context.
const createLawEndpoint = ({
  getAuthorization,
  resolve = resolveLawCitation,
}: LawRouteHandlerOptions) =>
  createSafeTokenHandler(
    lawConfig,
    async function* ({
      params,
      query,
      request,
      set,
    }): SafeHandlerGenerator<LegalResolveRouteResponse> {
      const prepared = await prepareLegalResolveRequest({
        getAuthorization,
        params,
        query,
        querySchema: strictQuery,
        request,
        set,
      });
      if (prepared.status === "rejected") {
        return Result.ok(prepared.body);
      }
      if (prepared.status === "invalid") {
        return Result.err(
          new HandlerError({ status: 422, message: prepared.message }),
        );
      }
      const response = yield* Result.ok(
        await resolve({
          admission: prepared.authorization.admission,
          country: prepared.params.country,
          input: prepared.query,
        }),
      );
      return Result.ok(response);
    },
  );

export const legalResolveLawEndpoint = createLawEndpoint({
  getAuthorization: authorizeLegalResolveRequestOnce,
});

export const createLegalResolveLawHandler = createLawEndpoint;
