import { Result } from "better-result";
import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";
import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";

import type {
  SafeHandlerGenerator,
  TokenHandlerConfig,
} from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { defaultVarcharSchema } from "@/api/lib/custom-schema";

import { resolveLawCitation } from "./law";
import type {
  GetLegalResolveAuthorization,
  LegalResolveResolved,
} from "./route-handler";
import {
  legalResolveBaseConfig,
  verifyLegalResolveCaller,
} from "./route-handler";

type LawRouteHandlerOptions = {
  getAuthorization: GetLegalResolveAuthorization;
  resolve?: typeof resolveLawCitation;
  onResolved?: LegalResolveResolved;
};

const lawConfig = {
  ...legalResolveBaseConfig,
  contract: "patch",
  query: v.object({
    citation: v.optional(v.pipe(v.string(), v.maxLength(512))),
    collection: v.optional(v.pipe(v.string(), v.maxLength(32))),
    year: v.optional(defaultVarcharSchema),
    number: v.optional(v.pipe(v.string(), v.maxLength(16))),
    section: v.optional(v.pipe(v.string(), v.maxLength(32))),
    asOf: v.optional(apiDateSchema),
  }),
} satisfies TokenHandlerConfig;

// The generator is written inline so the config types its context.
const createLawEndpoint = ({
  getAuthorization,
  resolve = resolveLawCitation,
  onResolved,
}: LawRouteHandlerOptions) =>
  createSafeTokenHandler(
    lawConfig,
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
          input: query,
        }),
      );
      onResolved?.(request, response);
      return Result.ok(response);
    },
  );

export const createLegalResolveLawHandler = createLawEndpoint;
