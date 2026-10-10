import { timingSafeEqual } from "node:crypto";

import { sha256Bytes as hashSha256Bytes } from "@stll/sha256/bun";

const BEARER_PREFIX = "Bearer ";

type AuthorizeConfiguredBearerOptions = {
  authorizationHeader: string | null;
  configuredToken: string | undefined;
};

export type ConfiguredBearerAccess =
  | { status: "disabled" }
  | { status: "unauthorized" }
  | { status: "authorized" };

/** Constant-time authorization for deployment-owned bearer credentials. */
export const authorizeConfiguredBearer = ({
  authorizationHeader,
  configuredToken,
}: AuthorizeConfiguredBearerOptions): ConfiguredBearerAccess => {
  if (configuredToken === undefined) {
    return { status: "disabled" };
  }
  if (
    authorizationHeader === null ||
    !authorizationHeader.startsWith(BEARER_PREFIX)
  ) {
    return { status: "unauthorized" };
  }

  const configuredDigest = hashSha256Bytes(configuredToken);
  const presentedDigest = hashSha256Bytes(
    authorizationHeader.slice(BEARER_PREFIX.length),
  );

  return timingSafeEqual(configuredDigest, presentedDigest)
    ? { status: "authorized" }
    : { status: "unauthorized" };
};
