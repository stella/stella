import { timingSafeEqual } from "node:crypto";

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

  const configuredDigest = new Bun.CryptoHasher("sha256")
    .update(configuredToken)
    .digest();
  const presentedDigest = new Bun.CryptoHasher("sha256")
    .update(authorizationHeader.slice(BEARER_PREFIX.length))
    .digest();

  return timingSafeEqual(configuredDigest, presentedDigest)
    ? { status: "authorized" }
    : { status: "unauthorized" };
};
