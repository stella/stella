import type { ApiClient, ExactRequestBody } from "./index";

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
const cachedBody = { name: "Created", queryKey: ["things"] };
const aliasedBody = cachedBody;
const spreadBody = { ...cachedBody };
type CurrentBody = Parameters<HeaderContractClient["current"]["post"]>[0];
const validBody = { name: "Created" };
true satisfies typeof validBody extends CurrentBody ? true : false;
true satisfies keyof CurrentBody extends "name" ? true : false;
true satisfies "name" extends keyof CurrentBody ? true : false;
true satisfies typeof cachedBody extends ExactRequestBody<
  CurrentBody,
  typeof cachedBody
>
  ? false
  : true;
true satisfies typeof aliasedBody extends ExactRequestBody<
  CurrentBody,
  typeof aliasedBody
>
  ? false
  : true;
true satisfies typeof spreadBody extends ExactRequestBody<
  CurrentBody,
  typeof spreadBody
>
  ? false
  : true;
const bodyWithClientMetadata = { name: "Created", optimisticId: "temporary" };
const spreadBodyWithClientMetadata = { ...bodyWithClientMetadata };
true satisfies typeof bodyWithClientMetadata extends ExactRequestBody<
  CurrentBody,
  typeof bodyWithClientMetadata
>
  ? false
  : true;
true satisfies typeof spreadBodyWithClientMetadata extends ExactRequestBody<
  CurrentBody,
  typeof spreadBodyWithClientMetadata
>
  ? false
  : true;
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

const inferHeaderContractOptions = (
  api: HeaderContractClient,
  safeUnion:
    { headers: { "x-trace": string } } | { fetch: { signal: AbortSignal } },
) => {
  const body = { name: "Created" };
  const request = { headers: { "x-stella-capability": "things.create" } };
  const current = api.current.post(body, request);
  const union = api.current.post(body, safeUnion);
  const inferredProof = api.proof.post(body, {
    headers: { "x-proof": "authorized", "x-trace": "request" },
    fetch: { signal: AbortSignal.timeout(1000) },
  });
  const inferredReplay = api.replay.post(body, {
    headers: { "iDeMpOtEnCy-KeY": "intent" },
    fetch: { headers: new Headers({ "idempotency-key": "intent" }) },
  });
  return { current, proof: inferredProof, replay: inferredReplay, union };
};

true satisfies Awaited<
  ReturnType<typeof inferHeaderContractOptions>["current"]
>["data"] extends {
  id: string;
} | null
  ? true
  : false;

type BodyContract<TBody> = Omit<HeaderContractRoute<unknown>, "body"> & {
  body: TBody;
};
type BodyContractClient = ApiClient<{
  properties: { patch: BodyContract<{ title?: string; subject?: string }> };
  empty: { post: BodyContract<Record<string, never>> };
}>;
type EmptyBody = Parameters<BodyContractClient["empty"]["post"]>[0];
true satisfies keyof EmptyBody extends string ? true : false;
true satisfies EmptyBody extends Record<string, never> ? true : false;

const inferBodyContract = (
  api: HeaderContractClient,
  bodies: BodyContractClient,
) => {
  const propertyKey: string = "title";
  const computed = bodies.properties.patch({ [propertyKey]: "Title" });
  const empty = bodies.empty.post({});
  // @ts-expect-error Cache metadata is not part of the request contract.
  const cached = api.current.post(cachedBody);
  // @ts-expect-error Aliasing cannot turn cache metadata into API input.
  const aliased = api.current.post(aliasedBody);
  // @ts-expect-error Spreading cannot turn cache metadata into API input.
  const spread = api.current.post(spreadBody);
  // @ts-expect-error Empty contract records accept no fields.
  const invalidEmpty = bodies.empty.post({ name: "Created" });
  // @ts-expect-error Client-only fields are rejected beyond cache metadata too.
  const metadata = api.current.post(bodyWithClientMetadata);
  return { computed, empty, cached, aliased, spread, invalidEmpty, metadata };
};
true satisfies Awaited<
  ReturnType<typeof inferBodyContract>["empty"]
>["data"] extends { id: string } | null
  ? true
  : false;
