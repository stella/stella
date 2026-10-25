import { panic, Result } from "better-result";
import { t } from "elysia";

import {
  MOBILE_RUNTIME_VERSION_PATTERN,
  MOBILE_UPDATE_PLATFORMS,
  MOBILE_UPDATE_VARIANTS,
} from "@stll/api-contract/mobile-updates";

import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
} from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  type CdnFetch,
  cdnFetch,
  mobileUpdateResponse,
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
  params: t.Object({ variant: t.UnionEnum(MOBILE_UPDATE_VARIANTS) }),
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
    async function* ({ params: { variant }, request }) {
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
        case "present":
          return Result.ok(
            mobileUpdateResponse(update.value, Bun.randomUUIDv7()),
          );
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
