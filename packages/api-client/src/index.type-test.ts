import type { ApiClient } from "./index";

type HeaderContractRoute<THeaders> = {
  body: { name: string };
  params: unknown;
  query: unknown;
  headers: THeaders;
  response: { 200: { id: string } };
};

type HeaderContractClient = ApiClient<{
  replay: {
    post: HeaderContractRoute<{ readonly "Idempotency-Key"?: string }>;
  };
  current: {
    post: HeaderContractRoute<{ readonly "Idempotency-Key"?: never }>;
  };
  proof: {
    post: HeaderContractRoute<{
      readonly "x-proof": string;
      readonly "Idempotency-Key"?: never;
    }>;
  };
}>;

type ReplayOptions = NonNullable<
  Parameters<HeaderContractClient["replay"]["post"]>[1]
>;
type CurrentOptions = NonNullable<
  Parameters<HeaderContractClient["current"]["post"]>[1]
>;
type ProofOptions = NonNullable<
  Parameters<HeaderContractClient["proof"]["post"]>[1]
>;

const capturedRequest = { headers: { "Idempotency-Key": "intent" } };
const aliasedRequest = capturedRequest;
const spreadRequest = { ...capturedRequest };
const replay: ReplayOptions = capturedRequest;
const replayFetch: ReplayOptions = {
  fetch: { headers: new Headers(capturedRequest.headers) },
};
const capability: CurrentOptions = {
  headers: { "x-stella-capability": "things.create" },
};
const proof: ProofOptions = {
  headers: { "x-proof": "authorized" },
  fetch: { headers: { "x-trace": "request" } },
};

true satisfies typeof replay extends ReplayOptions ? true : false;
true satisfies typeof replayFetch extends ReplayOptions ? true : false;
true satisfies typeof capability extends CurrentOptions ? true : false;
true satisfies typeof proof extends ProofOptions ? true : false;

// A captured request stays forbidden through aliasing and object spreads.
true satisfies typeof capturedRequest extends CurrentOptions ? false : true;
true satisfies typeof aliasedRequest extends CurrentOptions ? false : true;
true satisfies typeof spreadRequest extends CurrentOptions ? false : true;
// Per-call fetch overrides obey the same reserved header contract.
true satisfies {
  fetch: { headers: typeof capturedRequest.headers };
} extends CurrentOptions
  ? false
  : true;
true satisfies {
  fetch: { headers: Headers };
} extends CurrentOptions
  ? false
  : true;
true satisfies {
  fetch: { headers: ["Idempotency-Key", string][] };
} extends CurrentOptions
  ? false
  : true;
// Requiring a different header cannot erase the replay-key prohibition.
true satisfies Record<never, never> extends ProofOptions ? false : true;
true satisfies {
  headers: { "x-proof": string; "Idempotency-Key": string };
} extends ProofOptions
  ? false
  : true;

declare const headerContractApi: HeaderContractClient;

type MixedCaseRequest = { headers: { "iDeMpOtEnCy-KeY": string } };
type LowerCaseRequest = { headers: { "idempotency-key": string } };
type UpperCaseRequest = { headers: { "IDEMPOTENCY-KEY": string } };
type OpaqueRequest = { headers: Record<string, string> };
type OptionalOpaqueRequest = { headers?: Record<string, string> };
type MixedFetchRequest = {
  fetch: { headers: { "iDeMpOtEnCy-KeY": string } };
};
type UnionRequest = { headers: { "x-trace": string } } | MixedCaseRequest;

type CaseGuardOptions<TOptions> = NonNullable<
  Parameters<typeof headerContractApi.current.post<TOptions>>[1]
>;

true satisfies MixedCaseRequest extends CaseGuardOptions<MixedCaseRequest>
  ? false
  : true;
true satisfies LowerCaseRequest extends CaseGuardOptions<LowerCaseRequest>
  ? false
  : true;
true satisfies UpperCaseRequest extends CaseGuardOptions<UpperCaseRequest>
  ? false
  : true;
true satisfies OpaqueRequest extends CaseGuardOptions<OpaqueRequest>
  ? false
  : true;
true satisfies OptionalOpaqueRequest extends CaseGuardOptions<OptionalOpaqueRequest>
  ? false
  : true;
true satisfies MixedFetchRequest extends CaseGuardOptions<MixedFetchRequest>
  ? false
  : true;
true satisfies UnionRequest extends CaseGuardOptions<UnionRequest>
  ? false
  : true;

const inferHeaderContractOptions = (api: HeaderContractClient) => {
  const body = { name: "Created" };
  const request = { headers: { "x-stella-capability": "things.create" } };
  const current = api.current.post(body, request);
  const inferredProof = api.proof.post(body, {
    headers: { "x-proof": "authorized", "x-trace": "request" },
    fetch: { signal: AbortSignal.timeout(1000) },
  });
  const inferredReplay = api.replay.post(body, {
    headers: { "iDeMpOtEnCy-KeY": "intent" },
    fetch: { headers: new Headers({ "idempotency-key": "intent" }) },
  });
  return { current, proof: inferredProof, replay: inferredReplay };
};

true satisfies Awaited<
  ReturnType<typeof inferHeaderContractOptions>["current"]
>["data"] extends { id: string } | null
  ? true
  : false;
