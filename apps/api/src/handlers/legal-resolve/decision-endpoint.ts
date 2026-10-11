import { Result } from "better-result";
import { t } from "elysia";

import type {
  SafeHandlerGenerator,
  TokenHandlerConfig,
} from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { permissiveRouteSchema } from "@/api/lib/permissive-route-schema";

import { authorizeLegalResolveRequestOnce } from "./authorization";
import { resolveDecision } from "./decision";
import {
  type GetLegalResolveAuthorization,
  legalResolveBaseConfig,
  type LegalResolveRouteResponse,
  prepareLegalResolveRequest,
} from "./route-handler";

const strictQuery = t.Object({ identifier: t.String({ maxLength: 512 }) });

type DecisionRouteHandlerOptions = {
  getAuthorization: GetLegalResolveAuthorization;
  resolve?: typeof resolveDecision;
};

const decisionConfig = {
  ...legalResolveBaseConfig,
  query: permissiveRouteSchema({ keys: ["identifier"] }),
} satisfies TokenHandlerConfig;

// The generator is written inline so the config types its context.
const createDecisionEndpoint = ({
  getAuthorization,
  resolve = resolveDecision,
}: DecisionRouteHandlerOptions) =>
  createSafeTokenHandler(
    decisionConfig,
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
          identifier: prepared.query.identifier,
        }),
      );
      return Result.ok(response);
    },
  );

export const legalResolveDecisionEndpoint = createDecisionEndpoint({
  getAuthorization: authorizeLegalResolveRequestOnce,
});

export const createLegalResolveDecisionHandler = createDecisionEndpoint;
