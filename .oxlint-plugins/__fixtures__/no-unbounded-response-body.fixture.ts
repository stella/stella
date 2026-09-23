// Passive regression fixture for
// `no-unbounded-response-body/no-unbounded-response-body`.
//
// Each `oxlint-disable-next-line` suppresses a shape the rule MUST report; if
// the detector regresses, the directive becomes unused and the fixture lint
// fails. Everything without a directive is a shape the rule must NOT report.

import {
  getS3ObjectWithSignal,
  readS3ArrayBuffer as readWholeObject,
  readS3ObjectBounded,
} from "@/api/lib/s3";

declare const fetchWithTimeout: (url: string) => Promise<Response>;
declare const deps: { fetch: typeof fetch };
declare const request: Request;
declare const upload: File;
declare const sdkOutput: {
  Body: { transformToByteArray: () => Promise<Uint8Array> };
};
declare const cheerioSelection: { text: () => string };

const url = "https://example.test/resource";
const signal = AbortSignal.timeout(1000);

// Direct reads off a fetch call.
// oxlint-disable-next-line no-unbounded-response-body/no-unbounded-response-body -- fixture: awaited fetch read inline
const inline = await (await fetch(url, { signal })).json();

// A bound response, every body-materialising method.
const response = await fetchWithTimeout(url);
// oxlint-disable-next-line no-unbounded-response-body/no-unbounded-response-body -- fixture: text on a bound response
const text = await response.text();
// oxlint-disable-next-line no-unbounded-response-body/no-unbounded-response-body -- fixture: arrayBuffer on a clone
const buffer = await response.clone().arrayBuffer();
// oxlint-disable-next-line no-unbounded-response-body/no-unbounded-response-body -- fixture: bytes through an injected fetch
const injected = await (await deps.fetch(url, { signal })).bytes();

// Destructured parallel requests keep their provenance.
const [first, second] = await Promise.all([
  fetchWithTimeout(url),
  fetchWithTimeout(url),
]);
// oxlint-disable-next-line no-unbounded-response-body/no-unbounded-response-body -- fixture: Promise.all destructuring
const secondBlob = await second.blob();

// A same-file helper whose declared return type is a Response.
const requestUpstream = async (target: string): Promise<Response> =>
  await fetch(target, { signal });
// oxlint-disable-next-line no-unbounded-response-body/no-unbounded-response-body -- fixture: Response-returning local helper
const helperJson = await (await requestUpstream(url)).json();

// A parameter declared as a Response.
const readJson = async (upstream: Response | null) =>
  // oxlint-disable-next-line no-unbounded-response-body/no-unbounded-response-body -- fixture: Response-typed parameter
  await upstream?.json();

// Unbounded object-storage reads imported from the storage owner.
// oxlint-disable-next-line no-unbounded-response-body/no-unbounded-response-body -- fixture: aliased unbounded S3 reader
const object = await readWholeObject("key", signal);
// oxlint-disable-next-line no-unbounded-response-body/no-unbounded-response-body -- fixture: unbounded S3 reader
const probe = await getS3ObjectWithSignal("key", signal);
// oxlint-disable-next-line no-unbounded-response-body/no-unbounded-response-body -- fixture: AWS SDK body materialised whole
const sdkBytes = await sdkOutput.Body.transformToByteArray();

// --- Must NOT be reported ---

// The bounded reader, and a first response that is only inspected.
const bounded = await readS3ObjectBounded({
  bucket: "b",
  key: "key",
  maxBytes: 1024,
  signal,
});
const status = first.status;

// Request bodies and uploads are bounded by the route schema.
const requestBody = await request.arrayBuffer();
const uploadBytes = await upload.arrayBuffer();

// Local files, locally produced streams, and non-Response `.text()` calls.
const localFile = await Bun.file("/tmp/example").text();
const localStream = await new Response(new Blob(["x"]).stream()).text();
const selectionText = cheerioSelection.text();

// Provenance follows bindings: a shadowing parameter is not the response,
// and neither is a reassigned local.
// oxlint-disable-next-line eslint/no-shadow -- the shadow is the regression shape
const shadowed = async (response: { text: () => Promise<string> }) =>
  await response.text();
declare const useLocalCopy: boolean;
let reassigned = await fetchWithTimeout(url);
if (useLocalCopy) {
  reassigned = new Response("local");
}
const reassignedText = await reassigned.text();

export {
  bounded,
  buffer,
  helperJson,
  inline,
  injected,
  localFile,
  localStream,
  object,
  probe,
  readJson,
  reassignedText,
  requestBody,
  sdkBytes,
  secondBlob,
  selectionText,
  shadowed,
  status,
  text,
  uploadBytes,
};
