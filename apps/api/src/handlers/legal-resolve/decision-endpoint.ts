import { Result } from "better-result";
import * as v from "valibot";

import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";

import type {
  SafeHandlerGenerator,
  TokenHandlerConfig,
} from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";

import { resolveDecision } from "./decision";
import type {
  GetLegalResolveAuthorization,
  LegalResolveResolved,
} from "./route-handler";
import {
  legalResolveBaseConfig,
  verifyLegalResolveCaller,
} from "./route-handler";

type DecisionRouteHandlerOptions = {
  getAuthorization: GetLegalResolveAuthorization;
  resolve?: typeof resolveDecision;
  onResolved?: LegalResolveResolved;
};

const decisionConfig = {
  ...legalResolveBaseConfig,
  contract: "patch",
  query: v.object({
    identifier: v.pipe(v.string(), v.maxLength(512)),
  }),
} satisfies TokenHandlerConfig;

// The generator is written inline so the config types its context.
const createDecisionEndpoint = ({
  getAuthorization,
  resolve = resolveDecision,
  onResolved,
}: DecisionRouteHandlerOptions) =>
  createSafeTokenHandler(
    decisionConfig,
    verifyLegalResolveCaller(getAuthorization),
    async function* ({
      caller,
      params,
      query,
      request,
    }): SafeHandlerGenerator<LegalResolveResponse> {
      const response = yield* Result.ok(
        await resolve({
          admission: caller.admission,
          country: params.country,
          identifier: query.identifier,
        }),
      );
      onResolved?.(request, response);
      return Result.ok(response);
    },
  );

export const createLegalResolveDecisionHandler = createDecisionEndpoint;
