// Passive regression fixture for require-fetch-timeout.

declare const endpoint: string;
declare const request: Request;
declare const opaqueOptions: RequestInit;

// oxlint-disable-next-line require-fetch-timeout/require-fetch-timeout -- fixture: raw URL fetch has no cancellation signal
export const missingOptions = fetch(endpoint);
// oxlint-disable-next-line require-fetch-timeout/require-fetch-timeout -- fixture: object options omit cancellation signal
export const missingSignal = globalThis.fetch(endpoint, { method: "POST" });

export const timedFetch = fetch(endpoint, {
  signal: AbortSignal.timeout(10_000),
});
export const propagatedSignal = async (signal: AbortSignal) =>
  fetch(endpoint, { signal });
export const requestCarriesSignal = fetch(request);
export const opaqueInitMayCarrySignal = fetch(endpoint, opaqueOptions);
