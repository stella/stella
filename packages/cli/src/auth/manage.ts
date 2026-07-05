// `stella auth whoami` / `logout` / `switch`: read-mostly operations against
// the credential store, resolved for whichever server is currently active.

import { Result } from "better-result";

import {
  findCredentialByOrgHint,
  findDefaultCredential,
  listCredentialsForServer,
  readCredentialFile,
  removeCredential,
  setDefaultOrg,
  writeCredentialFile,
} from "./credential-store.js";
import type { StoredCredential } from "./credential-store.js";
import { CredentialNotFoundError } from "./errors.js";
import type { CliAuthError } from "./errors.js";
import { decodeAccessTokenClaims } from "./jwt.js";
import type { AccessTokenClaims } from "./jwt.js";

const resolveCredential = async (
  configDir: string,
  serverUrl: string,
  orgHint: string | undefined,
): Promise<
  Result<
    { credential: StoredCredential; allForServer: readonly StoredCredential[] },
    CliAuthError
  >
> => {
  const file = await readCredentialFile(configDir);
  const allForServer = listCredentialsForServer(file, serverUrl);

  const credential = orgHint
    ? findCredentialByOrgHint(file, serverUrl, orgHint)
    : findDefaultCredential(file, serverUrl);

  if (!credential) {
    const guidance =
      orgHint && allForServer.length > 0
        ? `Not signed in to "${orgHint}" on ${serverUrl}. Known orgs here: ${allForServer.map((c) => c.orgLabel ?? c.orgId).join(", ")}.`
        : `Not signed in to ${serverUrl}. Run \`stella auth login\`${orgHint ? ` --org ${orgHint}` : ""}.`;
    return Result.err(
      new CredentialNotFoundError({
        message: guidance,
        org: orgHint,
        serverUrl,
      }),
    );
  }

  return Result.ok({ allForServer, credential });
};

export type WhoamiInfo = {
  readonly serverUrl: string;
  readonly orgId: string;
  readonly orgLabel: string | undefined;
  readonly scope: string;
  readonly expiresAt: number;
  readonly isExpired: boolean;
  readonly hasRefreshToken: boolean;
  readonly claims: AccessTokenClaims | undefined;
};

export const whoami = async (
  configDir: string,
  serverUrl: string,
  orgHint: string | undefined,
): Promise<Result<WhoamiInfo, CliAuthError>> => {
  const resolved = await resolveCredential(configDir, serverUrl, orgHint);
  if (Result.isError(resolved)) {
    return Result.err(resolved.error);
  }
  const { credential } = resolved.value;

  return Result.ok({
    claims: decodeAccessTokenClaims(credential.accessToken),
    expiresAt: credential.expiresAt,
    hasRefreshToken: Boolean(credential.refreshToken),
    isExpired: credential.expiresAt <= Date.now(),
    orgId: credential.orgId,
    orgLabel: credential.orgLabel,
    scope: credential.scope,
    serverUrl: credential.serverUrl,
  });
};

export const logout = async (
  configDir: string,
  serverUrl: string,
  orgHint: string | undefined,
): Promise<Result<{ orgId: string }, CliAuthError>> => {
  const file = await readCredentialFile(configDir);
  const allForServer = listCredentialsForServer(file, serverUrl);

  if (allForServer.length === 0) {
    return Result.err(
      new CredentialNotFoundError({
        message: `Not signed in to ${serverUrl}.`,
        serverUrl,
      }),
    );
  }

  let target: StoredCredential | undefined;
  if (orgHint) {
    target = findCredentialByOrgHint(file, serverUrl, orgHint);
  } else if (allForServer.length === 1) {
    target = allForServer.at(0);
  }

  if (!target) {
    return Result.err(
      new CredentialNotFoundError({
        message: `Multiple organizations are signed in on ${serverUrl} (${allForServer.map((c) => c.orgLabel ?? c.orgId).join(", ")}); pass --org to pick one.`,
        serverUrl,
      }),
    );
  }

  await writeCredentialFile(
    configDir,
    removeCredential(file, serverUrl, target.orgId),
  );
  return Result.ok({ orgId: target.orgId });
};

export const switchOrg = async (
  configDir: string,
  serverUrl: string,
  orgHint: string,
): Promise<Result<{ orgId: string }, CliAuthError>> => {
  const file = await readCredentialFile(configDir);
  const target = findCredentialByOrgHint(file, serverUrl, orgHint);

  if (!target) {
    const allForServer = listCredentialsForServer(file, serverUrl);
    const known = allForServer.map((c) => c.orgLabel ?? c.orgId).join(", ");
    return Result.err(
      new CredentialNotFoundError({
        message: `Not signed in to "${orgHint}" on ${serverUrl}.${known ? ` Known orgs here: ${known}.` : ""} Run \`stella auth login --org ${orgHint}\` first.`,
        org: orgHint,
        serverUrl,
      }),
    );
  }

  await writeCredentialFile(
    configDir,
    setDefaultOrg(file, serverUrl, target.orgId),
  );
  return Result.ok({ orgId: target.orgId });
};
