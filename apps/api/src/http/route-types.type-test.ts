import * as v from "valibot";

import type { RouteTree } from "@/api/http/route-types";

const requiredHeaderSchema = v.object({ "x-proof": v.string() });

type ProjectionRoutes = RouteTree<{
  "/v1/replay": {
    POST: {
      config: { idempotency: { type: "replay" } };
      run: () => Promise<{ id: string }>;
    };
  };
  "/v1/current": {
    POST: {
      config: Record<never, never>;
      run: () => Promise<{ id: string }>;
    };
  };
  "/v1/widened": {
    POST: {
      config: { idempotency?: { type: "replay" } };
      run: () => Promise<{ id: string }>;
    };
  };
  "/v1/proof": {
    POST: {
      config: { headers: typeof requiredHeaderSchema };
      run: () => Promise<{ id: string }>;
    };
  };
}>;

type ReplayHeaders = ProjectionRoutes["v1"]["replay"]["post"]["headers"];
type CurrentHeaders = ProjectionRoutes["v1"]["current"]["post"]["headers"];
type WidenedHeaders = ProjectionRoutes["v1"]["widened"]["post"]["headers"];
type ProofHeaders = ProjectionRoutes["v1"]["proof"]["post"]["headers"];

const capturedHeaders = { "Idempotency-Key": "intent" };
const replay: ReplayHeaders = capturedHeaders;
const current: CurrentHeaders = {};
const proof: ProofHeaders = { "x-proof": "authorized" };

true satisfies typeof replay extends ReplayHeaders ? true : false;
true satisfies typeof current extends CurrentHeaders ? true : false;
true satisfies typeof proof extends ProofHeaders ? true : false;

// Non-replay and widened declarations cannot grant replay eligibility.
true satisfies typeof capturedHeaders extends CurrentHeaders ? false : true;
true satisfies typeof capturedHeaders extends WidenedHeaders ? false : true;
// Declared required headers survive the replay-policy projection.
true satisfies Record<never, never> extends ProofHeaders ? false : true;
true satisfies {
  "x-proof": string;
  "Idempotency-Key": string;
} extends ProofHeaders
  ? false
  : true;
