// Token storage.
//
// OS keychain is the target end state (see the design brief and
// `apps/desktop/src-tauri/src/keychain.rs`'s policy precedent), but wiring a
// native keyring binding is real native-dependency surface (napi-rs
// prebuilds, per-platform CI, etc.) that this phase deliberately does not
// pull in without a separate flag-and-discuss. The XDG file is the only
// backend today; `--no-keychain` (see `../commands/login.ts`) is accepted
// and threaded through for forward compatibility but is currently a no-op,
// since there is nothing else to fall back from yet.
//
// One credential per (serverUrl, orgId) pair, mode 0600, analogous to the
// `aws`/`gh` multi-profile credential file pattern.

import { Result } from "better-result";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import { defaultConfigDir, resolveConfigDir } from "./config-dir.js";
import type { ConfigPathOverrides } from "./config-dir.js";

export { defaultConfigDir, resolveConfigDir };
export type { ConfigPathOverrides };

const CREDENTIALS_FILE_MODE = 0o600;

// Hand-written rather than `v.InferOutput<typeof schema>`: this package
// builds with `isolatedDeclarations` (see `cli-config.ts` for the full
// rationale), which requires every exported type to be self-contained
// rather than derived from an unannotated schema expression.
export type StoredCredential = {
  readonly serverUrl: string;
  readonly orgId: string;
  /**
   * Best-effort label the user passed via `--org` at login time. Not
   * cryptographically verified against the token (see `login.ts` for why:
   * the server has no cheap org-slug-lookup endpoint and org selection
   * happens entirely in the browser). Purely a display/lookup convenience.
   */
  readonly orgLabel?: string | undefined;
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly scope: string;
  readonly tokenType: string;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type CredentialFile = {
  readonly version: 1;
  /** serverUrl -> orgId, the org used when a command targets a server without an explicit `--org`. */
  readonly defaultOrgByServer: Readonly<Record<string, string>>;
  readonly credentials: readonly StoredCredential[];
};

const storedCredentialSchema = v.strictObject({
  serverUrl: v.string(),
  orgId: v.string(),
  orgLabel: v.optional(v.string()),
  clientId: v.string(),
  accessToken: v.string(),
  refreshToken: v.optional(v.string()),
  scope: v.string(),
  tokenType: v.string(),
  expiresAt: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const credentialFileSchema = v.strictObject({
  version: v.literal(1),
  defaultOrgByServer: v.record(v.string(), v.string()),
  credentials: v.array(storedCredentialSchema),
});

const EMPTY_FILE: CredentialFile = {
  credentials: [],
  defaultOrgByServer: {},
  version: 1,
};

export const credentialsFilePath = (configDir: string): string =>
  path.join(configDir, "credentials.json");

export const readCredentialFile = async (
  configDir: string,
): Promise<CredentialFile> => {
  const filePath = credentialsFilePath(configDir);

  const raw = await Result.tryPromise(
    async () => await readFile(filePath, "utf-8"),
  );
  if (Result.isError(raw)) {
    return EMPTY_FILE;
  }

  const parsedJson = Result.try((): unknown => JSON.parse(raw.value));
  if (Result.isError(parsedJson)) {
    return EMPTY_FILE;
  }

  const parsed = v.safeParse(credentialFileSchema, parsedJson.value);
  return parsed.success ? parsed.output : EMPTY_FILE;
};

export const writeCredentialFile = async (
  configDir: string,
  file: CredentialFile,
): Promise<void> => {
  const filePath = credentialsFilePath(configDir);
  await mkdir(configDir, { mode: 0o700, recursive: true });
  await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, {
    mode: CREDENTIALS_FILE_MODE,
  });
  // `writeFile`'s `mode` option only applies when the file is created; force
  // it on every write so a pre-existing looser-permission file gets fixed.
  await chmod(filePath, CREDENTIALS_FILE_MODE);
};

const credentialKey = (serverUrl: string, orgId: string): string =>
  `${serverUrl}::${orgId}`;

export const findCredentialByOrgId = (
  file: CredentialFile,
  serverUrl: string,
  orgId: string,
): StoredCredential | undefined =>
  file.credentials.find(
    (credential) =>
      credentialKey(credential.serverUrl, credential.orgId) ===
      credentialKey(serverUrl, orgId),
  );

/** Matches on org id first, then the unverified `orgLabel`. */
export const findCredentialByOrgHint = (
  file: CredentialFile,
  serverUrl: string,
  orgHint: string,
): StoredCredential | undefined =>
  file.credentials.find(
    (credential) =>
      credential.serverUrl === serverUrl &&
      (credential.orgId === orgHint || credential.orgLabel === orgHint),
  );

export const findDefaultCredential = (
  file: CredentialFile,
  serverUrl: string,
): StoredCredential | undefined => {
  const defaultOrgId = file.defaultOrgByServer[serverUrl];
  if (defaultOrgId) {
    return findCredentialByOrgId(file, serverUrl, defaultOrgId);
  }
  return file.credentials.find(
    (credential) => credential.serverUrl === serverUrl,
  );
};

export const listCredentialsForServer = (
  file: CredentialFile,
  serverUrl: string,
): readonly StoredCredential[] =>
  file.credentials.filter((credential) => credential.serverUrl === serverUrl);

/** Inserts or replaces the (serverUrl, orgId) credential; sets it as the server's default if none was set. */
export const upsertCredential = (
  file: CredentialFile,
  credential: StoredCredential,
): CredentialFile => {
  const withoutExisting = file.credentials.filter(
    (existing) =>
      credentialKey(existing.serverUrl, existing.orgId) !==
      credentialKey(credential.serverUrl, credential.orgId),
  );

  const defaultOrgByServer = file.defaultOrgByServer[credential.serverUrl]
    ? file.defaultOrgByServer
    : { ...file.defaultOrgByServer, [credential.serverUrl]: credential.orgId };

  return {
    ...file,
    credentials: [...withoutExisting, credential],
    defaultOrgByServer,
  };
};

export const removeCredential = (
  file: CredentialFile,
  serverUrl: string,
  orgId: string,
): CredentialFile => {
  const credentials = file.credentials.filter(
    (existing) =>
      credentialKey(existing.serverUrl, existing.orgId) !==
      credentialKey(serverUrl, orgId),
  );

  if (file.defaultOrgByServer[serverUrl] !== orgId) {
    return { ...file, credentials };
  }

  // The removed credential was the server's default; drop it and, if
  // another credential remains for that server, promote it in one step
  // (destructuring-omit instead of `delete`, per repo convention).
  const { [serverUrl]: _removedDefault, ...remainingDefaults } =
    file.defaultOrgByServer;
  const nextDefault = credentials.find((c) => c.serverUrl === serverUrl);
  const defaultOrgByServer = nextDefault
    ? { ...remainingDefaults, [serverUrl]: nextDefault.orgId }
    : remainingDefaults;

  return { ...file, credentials, defaultOrgByServer };
};

export const setDefaultOrg = (
  file: CredentialFile,
  serverUrl: string,
  orgId: string,
): CredentialFile => ({
  ...file,
  defaultOrgByServer: { ...file.defaultOrgByServer, [serverUrl]: orgId },
});
