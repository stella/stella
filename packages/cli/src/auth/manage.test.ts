import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  readCredentialFile,
  upsertCredential,
  writeCredentialFile,
} from "./credential-store.js";
import type { CredentialFile, StoredCredential } from "./credential-store.js";
import { logout, switchOrg, whoami } from "./manage.js";

const SERVER = "https://stella.example";

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** A JWT-shaped access token carrying the given claims (unsigned; `whoami` decodes locally). */
const makeJwt = (claims: Record<string, unknown>): string =>
  `${base64url({ alg: "none", typ: "JWT" })}.${base64url(claims)}.sig`;

const buildCredential = (
  overrides: Partial<StoredCredential> = {},
): StoredCredential => ({
  accessToken: makeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    org_id: "org-1",
    sub: "user-1",
  }),
  clientId: "client-id",
  createdAt: 0,
  expiresAt: Date.now() + 3_600_000,
  orgId: "org-1",
  refreshToken: "refresh-1",
  scope: "openid stella:read",
  serverUrl: SERVER,
  tokenType: "Bearer",
  updatedAt: 0,
  ...overrides,
});

describe("auth manage (whoami / logout / switch)", () => {
  let configDir: string;

  const seed = async (credentials: readonly StoredCredential[]) => {
    let file: CredentialFile = {
      credentials: [],
      defaultOrgByServer: {},
      version: 1,
    };
    for (const credential of credentials) {
      file = upsertCredential(file, credential);
    }
    await writeCredentialFile(configDir, file);
    return file;
  };

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "stella-cli-manage-"));
  });

  afterEach(async () => {
    await rm(configDir, { force: true, recursive: true });
  });

  test("logout removes the credential from disk", async () => {
    await seed([buildCredential()]);

    const result = await logout(configDir, SERVER, undefined);
    expect(Result.isOk(result)).toBe(true);

    const persisted = await readCredentialFile(configDir);
    expect(persisted.credentials).toHaveLength(0);
    // The removed org was the default, so its default binding must be gone too.
    expect(persisted.defaultOrgByServer[SERVER]).toBeUndefined();
  });

  test("logout refuses to guess when multiple orgs are signed in, deleting nothing", async () => {
    await seed([
      buildCredential({ orgId: "org-1" }),
      buildCredential({ orgId: "org-2" }),
    ]);

    const result = await logout(configDir, SERVER, undefined);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("CredentialNotFoundError");
    }

    const persisted = await readCredentialFile(configDir);
    expect(persisted.credentials).toHaveLength(2);
  });

  test("logout with --org removes only the named org and promotes a remaining default", async () => {
    await seed([
      buildCredential({ orgId: "org-1", orgLabel: "Acme" }),
      buildCredential({ orgId: "org-2", orgLabel: "Beta" }),
    ]);

    const result = await logout(configDir, SERVER, "Acme");
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.orgId).toBe("org-1");
    }

    const persisted = await readCredentialFile(configDir);
    expect(persisted.credentials.map((c) => c.orgId)).toEqual(["org-2"]);
    // org-1 was the default; removal must re-point the default at the survivor.
    expect(persisted.defaultOrgByServer[SERVER]).toBe("org-2");
  });

  test("logout errors when the server has no credentials at all", async () => {
    const result = await logout(configDir, SERVER, undefined);
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("CredentialNotFoundError");
    } else {
      throw new TypeError("expected an error");
    }
  });

  test("switchOrg rejects an org the user is not signed in to, leaving the default untouched", async () => {
    await seed([buildCredential({ orgId: "org-1", orgLabel: "Acme" })]);

    const result = await switchOrg(configDir, SERVER, "not-a-member");
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("CredentialNotFoundError");
    }

    const persisted = await readCredentialFile(configDir);
    expect(persisted.defaultOrgByServer[SERVER]).toBe("org-1");
  });

  test("switchOrg re-points the default at a signed-in org", async () => {
    await seed([
      buildCredential({ orgId: "org-1", orgLabel: "Acme" }),
      buildCredential({ orgId: "org-2", orgLabel: "Beta" }),
    ]);

    const result = await switchOrg(configDir, SERVER, "Beta");
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.orgId).toBe("org-2");
    }

    const persisted = await readCredentialFile(configDir);
    expect(persisted.defaultOrgByServer[SERVER]).toBe("org-2");
  });

  test("whoami reports the stored credential shape and decodes JWT claims", async () => {
    await seed([
      buildCredential({
        expiresAt: Date.now() + 3_600_000,
        orgId: "org-1",
        orgLabel: "Acme",
        scope: "openid stella:read stella:search",
      }),
    ]);

    const result = await whoami(configDir, SERVER, undefined);
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.orgId).toBe("org-1");
      expect(result.value.orgLabel).toBe("Acme");
      expect(result.value.scope).toBe("openid stella:read stella:search");
      expect(result.value.hasRefreshToken).toBe(true);
      expect(result.value.isExpired).toBe(false);
      expect(result.value.claims?.org_id).toBe("org-1");
    }
  });

  test("whoami flags an expired credential and yields no claims for an opaque token", async () => {
    await seed([
      buildCredential({
        accessToken: "opaque-not-a-jwt",
        expiresAt: Date.now() - 1000,
        refreshToken: undefined,
      }),
    ]);

    const result = await whoami(configDir, SERVER, undefined);
    if (Result.isOk(result)) {
      expect(result.value.isExpired).toBe(true);
      expect(result.value.hasRefreshToken).toBe(false);
      // A non-JWT (opaque) access token has no locally decodable claims.
      expect(result.value.claims).toBeUndefined();
    } else {
      throw new TypeError("expected ok");
    }
  });

  test("whoami errors when not signed in to the server", async () => {
    const result = await whoami(configDir, SERVER, undefined);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("CredentialNotFoundError");
    }
  });
});
