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
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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

/** A genuinely-absent file (never signed in) vs. an unreadable/corrupt one. */
const isMissingFileError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT";
};

const corruptionWarning = (filePath: string, reason: string): string =>
  `stella: credentials file ${filePath} ${reason}; delete it and run 'stella auth login' to re-authenticate.`;

/**
 * Read the credential store. A genuinely-missing file (the user has never
 * signed in) resolves to the empty store silently. Anything else — an
 * unreadable file, invalid JSON, or a schema mismatch — is corruption, not
 * "not signed in": it warns to stderr with the file path (so the user can
 * delete it and re-login) and still falls back to the empty store so the
 * command degrades onto the unauthenticated path instead of crashing.
 *
 * `warn` is injectable so callers (and tests) can capture the corruption
 * notice; it defaults to the process's stderr, matching the rest of the CLI.
 */
export const readCredentialFile = async (
  configDir: string,
  warn: (message: string) => void = (message) =>
    void process.stderr.write(`${message}\n`),
): Promise<CredentialFile> => {
  const filePath = credentialsFilePath(configDir);

  const raw = await Result.tryPromise({
    // Preserve the raw Node error (the single-arg form wraps it) so the ENOENT
    // "genuinely absent" case can be told apart from an unreadable file.
    try: async (): Promise<string> => await readFile(filePath, "utf-8"),
    catch: (cause) => cause,
  });
  if (Result.isError(raw)) {
    if (!isMissingFileError(raw.error)) {
      warn(corruptionWarning(filePath, "could not be read"));
    }
    return EMPTY_FILE;
  }

  const parsedJson = Result.try((): unknown => JSON.parse(raw.value));
  if (Result.isError(parsedJson)) {
    warn(corruptionWarning(filePath, "is not valid JSON"));
    return EMPTY_FILE;
  }

  const parsed = v.safeParse(credentialFileSchema, parsedJson.value);
  if (!parsed.success) {
    warn(corruptionWarning(filePath, "does not match the expected schema"));
    return EMPTY_FILE;
  }
  return parsed.output;
};

/**
 * The filesystem primitives the atomic write uses, injectable so a test can
 * simulate a mid-write failure (e.g. a throwing `rename`) and assert the live
 * file is never left partially written. Defaults to `node:fs/promises`.
 */
export type AtomicWriteOps = {
  writeFile: (
    path: string,
    data: string,
    options: { mode: number },
  ) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
};

const defaultAtomicWriteOps: AtomicWriteOps = {
  writeFile: async (filePath, data, options) =>
    await writeFile(filePath, data, options),
  chmod: async (filePath, mode) => await chmod(filePath, mode),
  rename: async (oldPath, newPath) => await rename(oldPath, newPath),
  rm: async (filePath) => await rm(filePath, { force: true }),
};

/**
 * Persist the whole credential store. The write is atomic: the serialized file
 * lands in a sibling temp file (0600) and is then `rename`d over the live file,
 * so a crash mid-write can never truncate an existing store and lose every
 * org's credentials — a reader sees either the old file or the new one, never a
 * partial. The temp shares the target directory so the rename stays on one
 * filesystem (a cross-device rename is not atomic). A failed write drops the
 * temp and never touches the live file.
 *
 * Concurrent writers are out of scope (a last-writer-wins read-modify-write
 * race remains); this fix targets only the truncation/corruption mode, which
 * atomic replace eliminates.
 */
export const writeCredentialFile = async (
  configDir: string,
  file: CredentialFile,
  fsOps: AtomicWriteOps = defaultAtomicWriteOps,
): Promise<void> => {
  const filePath = credentialsFilePath(configDir);
  await mkdir(configDir, { mode: 0o700, recursive: true });

  // `process.pid` + `Date.now()` alone can collide: two concurrent writes in
  // the same process land in the same millisecond and would race on the same
  // temp path. `randomUUID` makes each call's temp path unique regardless of
  // timing.
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const written = await Result.tryPromise(async () => {
    await fsOps.writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, {
      mode: CREDENTIALS_FILE_MODE,
    });
    // `writeFile`'s `mode` only applies on creation; force it so the temp (and
    // thus the renamed-in live file) is always 0600 regardless of umask. The
    // rename replaces the target inode, so this also tightens a pre-existing
    // looser-permission credentials file.
    await fsOps.chmod(tempPath, CREDENTIALS_FILE_MODE);
    await fsOps.rename(tempPath, filePath);
  });
  if (Result.isError(written)) {
    // Best-effort cleanup so a failed write leaves no temp litter behind; the
    // live file was never opened, so it is already intact. The write's own
    // error (thrown below) is what surfaces to the caller — a failed
    // cleanup here has no further signal to add.
    const cleanup = await Result.tryPromise(
      async () => await fsOps.rm(tempPath),
    );
    if (Result.isError(cleanup)) {
      // Ignored: see comment above.
    }
    throw written.error;
  }
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
