import { describe, expect, test } from "bun:test";

import {
  mobileUpdateManifestKey,
  mobileUpdatePointerKey,
  mobileUpdateSignatureKey,
} from "@stll/api-contract/mobile-updates";
import type { Fetcher } from "@stll/fetch";

import {
  MOBILE_UPDATES_CDN_ORIGIN,
  mobileUpdateResponse,
  readSignedMobileUpdate,
} from "@/api/lib/mobile-updates/relay";

const TARGET = {
  variant: "preview",
  platform: "ios",
  runtimeVersion: "2965817a6ba1e5b803427be6ba77a293ad958df4",
} as const;

const UPDATE_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const MANIFEST = JSON.stringify({
  id: UPDATE_ID,
  runtimeVersion: TARGET.runtimeVersion,
});
const SIGNATURE = "c2lnbmF0dXJl";

/** A CDN holding `objects` by key, recording what was asked of it. */
const cdn = (objects: Record<string, string>, missingStatus = 404) => {
  const asked: string[] = [];
  const fetcher: Fetcher = async (input) => {
    const url = String(input);
    asked.push(url);
    const key = url.replace(`${MOBILE_UPDATES_CDN_ORIGIN}/`, "");
    return await Promise.resolve(
      key in objects
        ? new Response(objects[key])
        : new Response("missing", { status: missingStatus }),
    );
  };
  return { fetcher, asked };
};

const published = {
  [mobileUpdatePointerKey(TARGET)]: JSON.stringify({ updateId: UPDATE_ID }),
  [mobileUpdateManifestKey(TARGET, UPDATE_ID)]: MANIFEST,
  [mobileUpdateSignatureKey(TARGET, UPDATE_ID)]: `${SIGNATURE}\n`,
};

const read = async (objects: Record<string, string>, missingStatus = 404) => {
  const outcome = await readSignedMobileUpdate({
    fetcher: cdn(objects, missingStatus).fetcher,
    target: TARGET,
  });
  return outcome.type === "present" ? outcome.value : outcome.type;
};

describe("relaying a build's current update", () => {
  test("reads the pointer, then the exact signed manifest it names", async () => {
    const { fetcher, asked } = cdn(published);
    const outcome = await readSignedMobileUpdate({ fetcher, target: TARGET });
    expect(outcome.type === "present" && outcome.value).toEqual({
      manifest: MANIFEST,
      signature: SIGNATURE,
    });
    expect(
      asked.every((url) =>
        url.startsWith(`${MOBILE_UPDATES_CDN_ORIGIN}/mobile/preview/ios/`),
      ),
    ).toBe(true);
  });

  test("a build nothing was published for has no update", async () => {
    expect(await read({})).toBe("absent");
    // The bucket withholds listing, so the CDN answers a missing key with 403.
    expect(await read({}, 403)).toBe("refused");
  });

  test("a pointer to a missing or malformed update is an error, not an empty answer", async () => {
    const {
      [mobileUpdateSignatureKey(TARGET, UPDATE_ID)]: _signature,
      ...unsigned
    } = published;
    expect(await read(unsigned)).toBe("unavailable");
    expect(
      await read({
        ...published,
        [mobileUpdatePointerKey(TARGET)]: '{"updateId":"../x"}',
      }),
    ).toBe("unavailable");
    expect(
      await read({
        ...published,
        [mobileUpdateSignatureKey(TARGET, UPDATE_ID)]: 'sig", keyid="other',
      }),
    ).toBe("unavailable");
  });
});

describe("the protocol answer", () => {
  test("carries the manifest byte for byte with its signature beside it", async () => {
    const response = mobileUpdateResponse(
      { manifest: MANIFEST, signature: SIGNATURE },
      "boundary-1",
    );
    expect(response.headers.get("content-type")).toBe(
      "multipart/mixed; boundary=boundary-1",
    );
    expect(response.headers.get("expo-protocol-version")).toBe("1");
    const body = await response.text();
    expect(body).toContain(
      `expo-signature: sig="${SIGNATURE}", keyid="main"\r\n\r\n${MANIFEST}\r\n--boundary-1\r\n`,
    );
    expect(body.endsWith("--boundary-1--\r\n")).toBe(true);
  });
});
