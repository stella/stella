/**
 * Relays the mobile app's signed over-the-air updates (Expo Updates protocol
 * v1) from the downloads CDN.
 *
 * The API holds no signing key and alters nothing it relays: the publish job
 * signed the exact manifest text stored on the CDN, and a phone runs an
 * update only when that signature verifies against the certificate its
 * build embeds. A compromised relay can withhold updates, never forge one.
 *
 * It always answers with the newest update for the build that asks; a phone
 * already running it downloads nothing. That keeps every answer pre-signed,
 * since the protocol's "no update" directive would need a signature the API
 * cannot make.
 */

import { Result } from "better-result";
import * as v from "valibot";

import {
  MOBILE_UPDATE_ID_PATTERN,
  MOBILE_UPDATE_SIGNING_KEY_ID,
  type MobileUpdateTarget,
  mobileUpdateManifestKey,
  mobileUpdatePointerKey,
  mobileUpdateSignatureKey,
} from "@stll/api-contract/mobile-updates";
import { createFetchWithTimeout, type Fetcher } from "@stll/fetch";

import {
  readOutcomeOfStatus,
  readPresent,
  readUnavailable,
  type ReadOutcome,
} from "@/api/lib/errors/read-outcome";

/** stella's public downloads CDN, which the publish job writes to. */
export const MOBILE_UPDATES_CDN_ORIGIN = "https://downloads.stll.app";

const CDN_TIMEOUT_MS = 5000;

/** A manifest is a few kilobytes; anything far larger is not one. */
const MANIFEST_MAX_BYTES = 256 * 1024;

const pointerSchema = v.object({
  updateId: v.pipe(v.string(), v.regex(MOBILE_UPDATE_ID_PATTERN)),
});

const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;

export type SignedMobileUpdate = {
  readonly manifest: string;
  readonly signature: string;
};

const readCdnText = async (
  fetcher: Fetcher,
  url: string,
): Promise<ReadOutcome<string>> => {
  const fetched = await Result.tryPromise(
    async () =>
      await createFetchWithTimeout(fetcher)(url, {
        timeout: { type: "headers", ms: CDN_TIMEOUT_MS },
      }),
  );
  if (Result.isError(fetched)) {
    return readUnavailable({ kind: "thrown", error: fetched.error });
  }
  const response = fetched.value;
  if (!response.ok) {
    const outcome = readOutcomeOfStatus(response.status, "document");
    return outcome.type === "present"
      ? readUnavailable({ kind: "status", status: response.status })
      : outcome;
  }
  const text = await Result.tryPromise(async () => await response.text());
  if (Result.isError(text)) {
    return readUnavailable({ kind: "thrown", error: text.error });
  }
  return text.value.length > MANIFEST_MAX_BYTES
    ? readUnavailable({ kind: "too-large", maxBytes: MANIFEST_MAX_BYTES })
    : readPresent(text.value);
};

/**
 * The current signed update for a build. The CDN answers a missing object
 * with 404, or with 403 where the bucket withholds listing; both mean
 * nothing was published for the build. Anything wrong behind a pointer that
 * exists is unavailable, never an absence.
 */
export const readSignedMobileUpdate = async ({
  fetcher,
  origin = MOBILE_UPDATES_CDN_ORIGIN,
  target,
}: {
  readonly fetcher: Fetcher;
  readonly origin?: string;
  readonly target: MobileUpdateTarget;
}): Promise<ReadOutcome<SignedMobileUpdate>> => {
  const pointer = await readCdnText(
    fetcher,
    `${origin}/${mobileUpdatePointerKey(target)}`,
  );
  if (pointer.type !== "present") {
    return pointer;
  }
  const parsedPointer = v.safeParse(
    v.pipe(v.string(), v.parseJson(), pointerSchema),
    pointer.value,
  );
  if (!parsedPointer.success) {
    return readUnavailable({ kind: "empty-body", status: 200 });
  }
  const { updateId } = parsedPointer.output;
  const [manifest, signature] = await Promise.all([
    readCdnText(
      fetcher,
      `${origin}/${mobileUpdateManifestKey(target, updateId)}`,
    ),
    readCdnText(
      fetcher,
      `${origin}/${mobileUpdateSignatureKey(target, updateId)}`,
    ),
  ]);
  if (manifest.type !== "present") {
    return readUnavailable({ kind: "status", status: 404 });
  }
  const trimmed = signature.type === "present" ? signature.value.trim() : "";
  if (!SIGNATURE_PATTERN.test(trimmed)) {
    return readUnavailable({ kind: "empty-body", status: 200 });
  }
  return readPresent({ manifest: manifest.value, signature: trimmed });
};

/**
 * The protocol's multipart answer: the signed manifest, its signature in the
 * part's `expo-signature` header (a structured-field dictionary), and empty
 * extensions. Caching is the route's `CachePolicy`.
 */
export const mobileUpdateResponse = (
  update: SignedMobileUpdate,
  boundary: string,
): Response => {
  const crlf = "\r\n";
  const body = [
    `--${boundary}`,
    'content-disposition: form-data; name="manifest"',
    "content-type: application/json; charset=utf-8",
    `expo-signature: sig="${update.signature}", keyid="${MOBILE_UPDATE_SIGNING_KEY_ID}"`,
    "",
    update.manifest,
    `--${boundary}`,
    'content-disposition: form-data; name="extensions"',
    "content-type: application/json",
    "",
    JSON.stringify({ assetRequestHeaders: {} }),
    `--${boundary}--`,
    "",
  ].join(crlf);
  return new Response(body, {
    headers: {
      "content-type": `multipart/mixed; boundary=${boundary}`,
      "expo-protocol-version": "1",
      "expo-sfv-version": "0",
    },
  });
};
