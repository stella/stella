import { Result } from "better-result";

import {
  mobileUpdateManifestKey,
  mobileUpdatePointerKey,
  mobileUpdateSignatureKey,
} from "@stll/api-contract/mobile-updates";

import readMobileUpdate, {
  createReadMobileUpdateHandler,
} from "@/api/handlers/mobile-updates/read";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { MOBILE_UPDATES_CDN_ORIGIN } from "@/api/lib/mobile-updates/relay";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const TARGET = {
  variant: "preview",
  platform: "ios",
  runtimeVersion: "2965817a6ba1e5b803427be6ba77a293ad958df4",
} as const;
const UPDATE_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

/**
 * The relay reads three CDN objects by fixed keys and nothing from the
 * database, whatever the CDN holds for other builds.
 */
export const mobileUpdateScalingScenario = {
  name: "mobile update relay",
  handler: readMobileUpdate.handler,
  measure: async (otherBuilds: number) => {
    const objects = new Map<string, string>([
      [mobileUpdatePointerKey(TARGET), JSON.stringify({ updateId: UPDATE_ID })],
      [
        mobileUpdateManifestKey(TARGET, UPDATE_ID),
        JSON.stringify({ id: UPDATE_ID }),
      ],
      [mobileUpdateSignatureKey(TARGET, UPDATE_ID), "c2lnbmF0dXJl"],
    ]);
    for (let index = 0; index < otherBuilds; index += 1) {
      objects.set(`mobile/preview/ios/other-${index}/current.json`, "{}");
    }
    let cdnReads = 0;
    const handler = createReadMobileUpdateHandler(() => async (url) => {
      cdnReads += 1;
      const object = objects.get(
        url.replace(`${MOBILE_UPDATES_CDN_ORIGIN}/`, ""),
      );
      return await Promise.resolve(
        Result.ok({
          body: new TextEncoder().encode(object ?? "").buffer,
          headers: new Headers(),
          ok: object !== undefined,
          status: object === undefined ? 404 : 200,
        }),
      );
    });
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response = await handler.handler(
        asTestRaw<Parameters<typeof handler.handler>[0]>({
          params: { variant: TARGET.variant },
          request: new Request(
            "https://example.test/v1/mobile/updates/preview",
            {
              headers: {
                "expo-platform": TARGET.platform,
                "expo-runtime-version": TARGET.runtimeVersion,
              },
            },
          ),
          set: { headers: {} },
        }),
      );
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes:
          response instanceof Response ? (await response.text()).length : 0,
        rows: 1,
        cdnReads,
      };
    });
  },
};
