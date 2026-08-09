// Passive regression fixture for
// `require-safe-outbound-target/require-safe-outbound-target`.

import { fetchWithTimeout as unrelatedFetch } from "unrelated-fetch";

import { fetchWithTimeout } from "@stll/fetch";

import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import { fetchWithTimeout as aliasedFetch } from "@/api/lib/fetch";
import { restrictSkCourtDocumentUrl } from "@/api/lib/legal-search/sk-court-document-url";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";
import { getS3 } from "@/api/lib/s3";
import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";

const STATIC_BASE = "https://api.example.com";
const STATIC_ALIAS = STATIC_BASE;

declare const dynamicBase: string;
declare const dynamicPath: string;
declare const signal: AbortSignal;

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
