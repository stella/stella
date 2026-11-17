import { Result } from "better-result";
// `stella auth whoami` / `logout` / `switch`: read-mostly operations against
// the credential store, resolved for whichever server is currently active.
import { Temporal } from "temporal-polyfill/full";

import {
  findCredentialByOrgHint,
  findDefaultCredential,
  listCredentialsForServer,
  readCredentialFile,
  removeCredential,
  setDefaultOrg,
  updateCredentialFile,
} from "./credential-store.js";
import type { CredentialFile, StoredCredential } from "./credential-store.js";
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
  readonly email: string | undefined;
  readonly name: string | undefined;
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
    email: credential.email,
    expiresAt: credential.expiresAt,
    name: credential.name,
    hasRefreshToken: Boolean(credential.refreshToken),
    isExpired: credential.expiresAt <= Temporal.Now.instant().epochMilliseconds,
    orgId: credential.orgId,
    orgLabel: credential.orgLabel,
    scope: credential.scope,
    serverUrl: credential.serverUrl,
  });
};

const removeSelectedCredential = (
  file: CredentialFile,
  serverUrl: string,
  orgHint: string | undefined,
): Result<{ orgId: string; file: CredentialFile }, CliAuthError> => {
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

  return Result.ok({
    orgId: target.orgId,
    file: removeCredential(file, serverUrl, target.orgId),
  });
};

const selectDefaultOrg = (
  file: CredentialFile,
  serverUrl: string,
  orgHint: string,
): Result<{ orgId: string; file: CredentialFile }, CliAuthError> => {
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

  return Result.ok({
    orgId: target.orgId,
    file: setDefaultOrg(file, serverUrl, target.orgId),
  });
};

type CredentialSelection = Result<
  { orgId: string; file: CredentialFile },
  CliAuthError
>;

const selectedCredentialUpdate = (selection: CredentialSelection) => {
  if (selection.isErr()) {
    return { status: "unchanged", value: selection } as const;
  }
  return {
    status: "updated",
    file: selection.value.file,
    value: Result.ok({ orgId: selection.value.orgId }),
  } as const;
};

export const logout = async (
  configDir: string,
  serverUrl: string,
  orgHint: string | undefined,
): Promise<Result<{ orgId: string }, CliAuthError>> => {
  const updated = await updateCredentialFile(configDir, (file) =>
    selectedCredentialUpdate(
      removeSelectedCredential(file, serverUrl, orgHint),
    ),
  );
  return updated.isErr() ? updated : updated.value;
};

export const switchOrg = async (
  configDir: string,
  serverUrl: string,
  orgHint: string,
): Promise<Result<{ orgId: string }, CliAuthError>> => {
  const updated = await updateCredentialFile(configDir, (file) =>
    selectedCredentialUpdate(selectDefaultOrg(file, serverUrl, orgHint)),
  );
  return updated.isErr() ? updated : updated.value;
};
