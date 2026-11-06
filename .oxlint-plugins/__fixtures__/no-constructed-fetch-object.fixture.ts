// Passive regression fixture for
// `no-constructed-fetch-object/no-constructed-fetch-object`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

declare const response: Response;
declare const stream: ReadableStream<Uint8Array>;

// --- Flagged: fetch objects built from the global classes ---
// oxlint-disable-next-line no-constructed-fetch-object/no-constructed-fetch-object -- fixture: a response rebuilt around the platform stream
export const _a = new Response(stream, { status: response.status });
// oxlint-disable-next-line no-constructed-fetch-object/no-constructed-fetch-object -- fixture: the global class read off globalThis
export const _b = new globalThis.Request("https://example.test");
// oxlint-disable-next-line no-constructed-fetch-object/no-constructed-fetch-object -- fixture: a static factory builds a response too
export const _c = Response.json({ ok: true });

// --- Allowed: the platform response itself, and a shadowed class ---
// expect-clean: no-constructed-fetch-object/no-constructed-fetch-object
export const _d = response;
// expect-clean: no-constructed-fetch-object/no-constructed-fetch-object
export const _e = (Request: new () => object) => new Request();
