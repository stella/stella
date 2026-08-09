// Passive regression fixture for
// `require-safe-outbound-target/require-safe-outbound-target`.

import { fetchWithTimeout as unrelatedFetch } from "unrelated-fetch";

import { fetchWithTimeout } from "@stll/fetch";

import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import { fetchWithTimeout as aliasedFetch } from "@/api/lib/fetch";
import * as http from "@/api/lib/fetch";
import { restrictSkCourtDocumentUrl } from "@/api/lib/legal-search/sk-court-document-url";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";
import { getS3 } from "@/api/lib/s3";
import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";

import { fetchWithTimeout as relativeFetch } from "../../apps/api/src/lib/fetch.ts";

const STATIC_BASE = "https://api.example.com";
const STATIC_ALIAS = STATIC_BASE;

declare const dynamicBase: string;
declare const dynamicPath: string;
declare const signal: AbortSignal;
declare const spreadPolicyOverride: {
  hostPolicy?: {
    type: "exact-origin";
    origins: string[];
  };
};
declare const spreadRedirectOverride: { redirect?: RequestRedirect };
declare const mutateTarget: (target: URL, hostname: string) => void;

export const mustFlagDynamicTargets = async (inputUrl: string) => {
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: a parameter has no proven destination origin
  await fetchWithTimeout(inputUrl, { timeoutMs: 1000 });

  const alias = inputUrl;
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: a stable alias of an arbitrary URL remains arbitrary
  await aliasedFetch(alias, { timeoutMs: 1000 });

  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: the dynamic interpolation controls the authority
  await fetchWithTimeout(`${dynamicBase}/items`, { timeoutMs: 1000 });

  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: a dynamic port changes the destination origin
  await fetchWithTimeout(`https://api.example.com:${dynamicPath}/items`, {
    timeoutMs: 1000,
  });

  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: retry wrappers cannot make an arbitrary destination trustworthy
  await fetchWithRetry(inputUrl, undefined, { signal });

  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: relative extension-bearing imports remain recognized network sinks
  await relativeFetch(inputUrl, { timeoutMs: 1000 });

  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: genuine global fetch is also an outbound sink
  await globalThis.fetch(inputUrl, { signal });

  const dynamicPolicy = restrictOutboundUrl({
    rawUrl: inputUrl,
    hostPolicy: {
      type: "exact-origin",
      origins: [new globalThis.URL(inputUrl).origin],
    },
  });
  if (dynamicPolicy !== null) {
    // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: a dynamically derived allowlist cannot establish a trust boundary
    await fetchWithTimeout(dynamicPolicy, { timeoutMs: 1000 });
  }

  const mutableUrl = new URL("https://api.example.com/items");
  mutableUrl.hostname = inputUrl;
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: mutating a URL's authority invalidates its static origin proof
  await fetchWithTimeout(mutableUrl, { timeoutMs: 1000 });

  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: an absolute runtime first argument overrides the fixed URL base
  await fetchWithTimeout(new URL(inputUrl, STATIC_BASE), { timeoutMs: 1000 });

  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: special-scheme URL parsing treats a backslash after a slash as an authority delimiter
  await fetchWithTimeout(new URL(`/\\${inputUrl}`, STATIC_BASE), {
    timeoutMs: 1000,
  });

  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: URL parsing strips leading whitespace before an authority delimiter
  await fetchWithTimeout(new URL(` //${inputUrl}`, STATIC_BASE), {
    timeoutMs: 1000,
  });

  const originalUrl = new URL("https://api.example.com/items");
  const urlAlias = originalUrl;
  urlAlias.hostname = inputUrl;
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: mutating a URL through an alias invalidates the original binding's proof
  await fetchWithTimeout(originalUrl, { timeoutMs: 1000 });

  const computedMutationUrl = new URL("https://api.example.com/items");
  const authorityKey = "hostname";
  computedMutationUrl[authorityKey] = inputUrl;
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: a stable computed authority key invalidates the URL's static proof
  await fetchWithTimeout(computedMutationUrl, { timeoutMs: 1000 });

  const overriddenStringifier = new URL("https://api.example.com/items");
  overriddenStringifier.toString = () => inputUrl;
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: replacing a URL's stringifier invalidates its fixed-origin proof
  await fetchWithTimeout(overriddenStringifier.toString(), {
    timeoutMs: 1000,
  });

  const escapedUrl = new URL("https://api.example.com/items");
  mutateTarget(escapedUrl, inputUrl);
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: a mutable URL passed to an unknown helper can have its authority changed
  await fetchWithTimeout(escapedUrl, { timeoutMs: 1000 });

  const containedUrl = new URL("https://api.example.com/items");
  const holder = { target: containedUrl };
  holder.target.hostname = inputUrl;
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: storing a mutable URL in a container lets the container mutate its authority
  await fetchWithTimeout(containedUrl, { timeoutMs: 1000 });

  const request = fetchWithTimeout;
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: stable local aliases of imported fetch wrappers remain network sinks
  await request(inputUrl, { timeoutMs: 1000 });

  const globalRequest = globalThis.fetch;
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: stable local aliases of global fetch remain network sinks
  await globalRequest(inputUrl, { signal });

  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: namespace-imported wrappers remain network sinks
  await http.fetchWithTimeout(inputUrl, { timeoutMs: 1000 });

  const namespaceRequest = http.fetchWithTimeout;
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: stable aliases of namespace-imported wrappers remain network sinks
  await namespaceRequest(inputUrl, { timeoutMs: 1000 });

  // oxlint-disable-next-line no-useless-call, require-safe-outbound-target/require-safe-outbound-target -- fixture: Function.call cannot bypass target analysis
  await fetchWithTimeout.call(undefined, inputUrl, { timeoutMs: 1000 });

  // oxlint-disable-next-line no-useless-call, require-safe-outbound-target/require-safe-outbound-target -- fixture: Function.apply cannot bypass target analysis
  await fetchWithTimeout.apply(undefined, [inputUrl, { timeoutMs: 1000 }]);

  const boundRequest = fetchWithTimeout.bind(undefined);
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: a bound fetch wrapper remains a network sink
  await boundRequest(inputUrl, { timeoutMs: 1000 });

  const mutableOrigins = ["https://provider.example"];
  mutableOrigins.push(new URL(inputUrl).origin);
  const widenedPolicy = restrictOutboundUrl({
    rawUrl: inputUrl,
    hostPolicy: { type: "exact-origin", origins: mutableOrigins },
  });
  if (widenedPolicy !== null) {
    // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: mutating a const policy array invalidates its static trust proof
    await fetchWithTimeout(widenedPolicy, {
      redirect: "error",
      timeoutMs: 1000,
    });
  }

  const aliasedOrigins = ["https://provider.example"];
  const originsAlias = aliasedOrigins;
  originsAlias.push(new URL(inputUrl).origin);
  const aliasWidenedPolicy = restrictOutboundUrl({
    rawUrl: inputUrl,
    hostPolicy: { type: "exact-origin", origins: aliasedOrigins },
  });
  if (aliasWidenedPolicy !== null) {
    // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: mutating a policy array through an alias invalidates its proof
    await fetchWithTimeout(aliasWidenedPolicy, {
      redirect: "error",
      timeoutMs: 1000,
    });
  }

  const redirectableProviderUrl = restrictOutboundUrl({
    rawUrl: inputUrl,
    hostPolicy: {
      type: "exact-origin",
      origins: ["https://provider.example"],
    },
  });
  if (redirectableProviderUrl !== null) {
    // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: provider-restricted targets must reject redirects at the network sink
    await fetchWithTimeout(redirectableProviderUrl, { timeoutMs: 1000 });
  }

  const spreadPolicy = restrictOutboundUrl({
    rawUrl: inputUrl,
    hostPolicy: {
      type: "exact-origin",
      origins: ["https://provider.example"],
    },
    ...spreadPolicyOverride,
  });
  if (spreadPolicy !== null) {
    // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: an opaque spread can replace a proven host policy
    await fetchWithTimeout(spreadPolicy, {
      redirect: "error",
      timeoutMs: 1000,
    });
  }

  const spreadRedirect = restrictOutboundUrl({
    rawUrl: inputUrl,
    hostPolicy: {
      type: "exact-origin",
      origins: ["https://provider.example"],
    },
  });
  if (spreadRedirect !== null) {
    // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: an opaque spread can replace redirect: error
    await fetchWithTimeout(spreadRedirect, {
      redirect: "error",
      ...spreadRedirectOverride,
      timeoutMs: 1000,
    });
  }
};

export const mustAllowFixedOrigins = async (id: string) => {
  await fetchWithTimeout("https://api.example.com/items", {
    timeoutMs: 1000,
  });
  await fetchWithTimeout(`${STATIC_ALIAS}/items/${id}`, {
    timeoutMs: 1000,
  });
  await fetchWithTimeout(`https://api.example.com/items/${id}`, {
    timeoutMs: 1000,
  });
  await fetchWithTimeout(new URL(`/items/${id}`, STATIC_BASE), {
    timeoutMs: 1000,
  });
  const target = new URL("https://api.example.com/items");
  target.searchParams.set("id", id);
  await fetchWithTimeout(target, { timeoutMs: 1000 });
  // eslint-disable-next-line typescript/dot-notation -- fixture: static computed access reaches the genuine global fetch binding
  await globalThis["fetch"](`https://api.example.com/items/${id}`, {
    signal,
  });
};

export const mustAllowCanonicalBoundary = async (inputUrl: string) => {
  await safeOutboundFetchBytes({
    url: inputUrl,
    maxBytes: 1024,
    timeoutMs: 1000,
  });

  const providerUrl = restrictOutboundUrl({
    rawUrl: inputUrl,
    hostPolicy: {
      type: "exact-origin",
      origins: ["https://provider.example"],
    },
  });
  if (providerUrl !== null) {
    await fetchWithTimeout(providerUrl, {
      redirect: "error",
      timeoutMs: 1000,
    });
  }

  const skCourtUrl = restrictSkCourtDocumentUrl(inputUrl);
  if (skCourtUrl !== null) {
    await fetchWithTimeout(skCourtUrl, {
      redirect: "error",
      timeoutMs: 1000,
    });
  }

  await fetchWithTimeout(new URL("https://api.example.com/items").toString(), {
    timeoutMs: 1000,
  });
  await fetchWithTimeout(getS3().presign("fixtures/outbound-target"), {
    timeoutMs: 1000,
  });
};

export const mustAllowUnrelatedBindings = async (
  fetch: (url: string) => Promise<unknown>,
  URL: typeof globalThis.URL,
) => {
  await fetch(dynamicBase);
  await unrelatedFetch(dynamicBase, { timeoutMs: 1000 });

  const localTarget = new URL(dynamicBase);
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- fixture: a shadowed URL constructor cannot prove the imported fetch target
  await fetchWithTimeout(localTarget, { timeoutMs: 1000 });
};
