import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  MOBILE_RUNTIME_VERSION_PATTERN,
  MOBILE_UPDATE_PLATFORMS,
  MOBILE_UPDATE_VARIANTS,
} from "@stll/api-contract/mobile-updates";

import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  type CdnFetch,
  cdnFetch,
  MOBILE_UPDATE_ANSWER_MAX_LENGTH,
  mobileUpdateAnswer,
  readSignedMobileUpdate,
} from "@/api/lib/mobile-updates/relay";

const config = {
  contract: "patch",
  contentDelivery: {
    type: "public",
    reason: "Relays the mobile app's signed public updates.",
  },
  // The protocol's own policy: a phone asks again on every launch.
  cache: { kind: "private", maxAge: 0 },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
  params: v.object({ variant: v.picklist(MOBILE_UPDATE_VARIANTS) }),
  // The multipart answer, bounded by what the relay reads from the CDN.
  response: safePublicHandlerResponseSchemasWithStatusText(
    v.pipe(v.string(), v.maxLength(MOBILE_UPDATE_ANSWER_MAX_LENGTH)),
  ),
} satisfies PublicHandlerConfig;

/**
 * The current over-the-air update for the build that asks (Expo Updates
 * protocol v1). The build names its platform and runtime version in the
 * protocol's headers; both are checked against their fixed shapes before
 * they reach a CDN path. A build nothing was published for gets 404 and
 * keeps the bundle it shipped.
 */
export const createReadMobileUpdateHandler = (
  fetchObject: () => CdnFetch = () => cdnFetch(grantThirdPartyOutboundPermit()),
) =>
  createSafeBoundedPublicHandler(
    config,
    async function* ({ params: { variant }, request, set }) {
      const platform = MOBILE_UPDATE_PLATFORMS.find(
        (candidate) => candidate === request.headers.get("expo-platform"),
      );
      const runtimeVersion = request.headers.get("expo-runtime-version") ?? "";
      if (
        platform === undefined ||
        !MOBILE_RUNTIME_VERSION_PATTERN.test(runtimeVersion)
      ) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "expo-platform and expo-runtime-version are required",
          }),
        );
      }
      const update = yield* Result.ok(
        await readSignedMobileUpdate({
          fetchObject: fetchObject(),
          target: { variant, platform, runtimeVersion },
        }),
      );
      switch (update.type) {
        case "present": {
          const answer = mobileUpdateAnswer(update.value, Bun.randomUUIDv7());
          for (const [name, value] of Object.entries(answer.headers)) {
            set.headers[name] = value;
          }
          return Result.ok(answer.body);
        }
        case "absent":
        case "refused":
          return Result.err(
            new HandlerError({
              status: 404,
              message: "No update for this build",
            }),
          );
        case "unavailable":
          return Result.err(
            new HandlerError({
              status: 503,
              message: "The current update cannot be read right now",
            }),
          );
        default:
          update satisfies never;
          return panic("Unhandled update read outcome");
      }
    },
  );

const readMobileUpdate = createReadMobileUpdateHandler();

export default readMobileUpdate;
