import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  credentialsFilePath,
  findCredentialByOrgHint,
  findCredentialByOrgId,
  findDefaultCredential,
  listCredentialsForServer,
  readCredentialFile,
  removeCredential,
  resolveConfigDir,
  setDefaultOrg,
  upsertCredential,
  writeCredentialFile,
} from "./credential-store.js";
import type { AtomicWriteOps, StoredCredential } from "./credential-store.js";

const buildCredential = (
  overrides: Partial<StoredCredential> = {},
): StoredCredential => ({
  accessToken: "access-token",
  clientId: "client-id",
  createdAt: 1000,
  expiresAt: 2000,
  orgId: "org-1",
  scope: "openid stella:read",
  serverUrl: "https://stella.example",
  tokenType: "Bearer",
  updatedAt: 1000,
  ...overrides,
});

describe("resolveConfigDir", () => {
  test("prefers XDG_CONFIG_HOME when set", () => {
    expect(
      resolveConfigDir({
        homeDir: "/home/alice",
        xdgConfigHome: "/custom/xdg",
      }),
    ).toBe(path.join("/custom/xdg", "stella"));
  });

  test("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    expect(resolveConfigDir({ homeDir: "/home/alice" })).toBe(
      path.join("/home/alice", ".config", "stella"),
    );
  });

  test("treats an empty XDG_CONFIG_HOME as unset", () => {
    expect(
      resolveConfigDir({ homeDir: "/home/alice", xdgConfigHome: "" }),
    ).toBe(path.join("/home/alice", ".config", "stella"));
  });
});

describe("credential file round-trip (tmp XDG dir)", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "stella-cli-test-"));
  });

  afterEach(async () => {
    await rm(configDir, { force: true, recursive: true });
  });

  test("readCredentialFile returns an empty file when none exists yet", async () => {
    const file = await readCredentialFile(configDir);
    expect(file).toEqual({
      credentials: [],
      defaultOrgByServer: {},
      version: 1,
    });
  });

  test("a genuinely-absent file is silent (never signed in, not corruption)", async () => {
    const warnings: string[] = [];
    const file = await readCredentialFile(configDir, (message) =>
      warnings.push(message),
    );
    expect(file).toEqual({
      credentials: [],
      defaultOrgByServer: {},
      version: 1,
    });
    expect(warnings).toEqual([]);
  });

  test("round-trips a written credential file exactly", async () => {
    const credential = buildCredential();
    const written = upsertCredential(
      await readCredentialFile(configDir),
      credential,
    );
    await writeCredentialFile(configDir, written);

    const reread = await readCredentialFile(configDir);
    expect(reread).toEqual(written);
  });

  test("writes the credentials file with mode 0600", async () => {
    await writeCredentialFile(
      configDir,
      upsertCredential(await readCredentialFile(configDir), buildCredential()),
    );

    const stats = await stat(credentialsFilePath(configDir));
    // eslint-disable-next-line no-bitwise -- masking the permission bits out of `stat().mode` requires `&`; there is no non-bitwise API for this
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test("tightens an existing file's permissions on rewrite", async () => {
    await writeCredentialFile(
      configDir,
      upsertCredential(await readCredentialFile(configDir), buildCredential()),
    );
    await chmod(credentialsFilePath(configDir), 0o644);

    await writeCredentialFile(
      configDir,
      upsertCredential(
        await readCredentialFile(configDir),
        buildCredential({ orgId: "org-2" }),
      ),
    );

    const stats = await stat(credentialsFilePath(configDir));
    // eslint-disable-next-line no-bitwise -- masking the permission bits out of `stat().mode` requires `&`; there is no non-bitwise API for this
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test("warns (with the path) and falls back to empty on a non-JSON file", async () => {
    await Bun.write(credentialsFilePath(configDir), "not json");
    const warnings: string[] = [];
    const file = await readCredentialFile(configDir, (message) =>
      warnings.push(message),
    );
    expect(file).toEqual({
      credentials: [],
      defaultOrgByServer: {},
      version: 1,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings.at(0)).toContain(credentialsFilePath(configDir));
    expect(warnings.at(0)).toContain("not valid JSON");
  });

  test("warns and falls back to empty on a schema-mismatched file", async () => {
    await Bun.write(
      credentialsFilePath(configDir),
      JSON.stringify({ credentials: "not-an-array", version: 99 }),
    );
    const warnings: string[] = [];
    const file = await readCredentialFile(configDir, (message) =>
      warnings.push(message),
    );
    expect(file.credentials).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings.at(0)).toContain("schema");
  });

  test("a successful write leaves no temp files behind", async () => {
    await writeCredentialFile(
      configDir,
      upsertCredential(await readCredentialFile(configDir), buildCredential()),
    );
    expect(await readdir(configDir)).toEqual(["credentials.json"]);
  });

  test("a failed write leaves the existing credential store intact", async () => {
    const original = upsertCredential(
      await readCredentialFile(configDir),
      buildCredential({ orgId: "org-1" }),
    );
    await writeCredentialFile(configDir, original);

    // Inject a `rename` that throws to simulate a crash at the atomic point,
    // after the temp file is written but before it replaces the live file.
    const failingRename: AtomicWriteOps = {
      writeFile: async (filePath, data, options) =>
        await writeFile(filePath, data, options),
      chmod: async (filePath, mode) => await chmod(filePath, mode),
      rename: () => {
        throw new Error("simulated crash before rename");
      },
      rm: async (filePath) => await rm(filePath, { force: true }),
    };

    const replacement = upsertCredential(
      original,
      buildCredential({ accessToken: "new-token", orgId: "org-2" }),
    );
    await expect(
      writeCredentialFile(configDir, replacement, failingRename),
    ).rejects.toThrow("simulated crash before rename");

    // Live file is byte-for-byte the pre-failure store: no truncation, no
    // partial write, and the failed temp was cleaned up.
    expect(await readCredentialFile(configDir)).toEqual(original);
    expect(await readdir(configDir)).toEqual(["credentials.json"]);
  });
});

describe("credential store data operations", () => {
  const empty = {
    credentials: [],
    defaultOrgByServer: {},
    version: 1 as const,
  };

  test("upsertCredential sets the first credential for a server as its default", () => {
    const credential = buildCredential();
    const file = upsertCredential(empty, credential);
    expect(file.defaultOrgByServer[credential.serverUrl]).toBe(
      credential.orgId,
    );
  });

  test("upsertCredential does not change the default when adding a second org", () => {
    const first = buildCredential({ orgId: "org-1" });
    const second = buildCredential({ orgId: "org-2" });
    const file = upsertCredential(upsertCredential(empty, first), second);
    expect(file.defaultOrgByServer[first.serverUrl]).toBe("org-1");
    expect(file.credentials).toHaveLength(2);
  });

  test("upsertCredential replaces an existing (serverUrl, orgId) pair rather than duplicating", () => {
    const original = buildCredential({ accessToken: "old-token" });
    const updated = buildCredential({ accessToken: "new-token" });
    const file = upsertCredential(upsertCredential(empty, original), updated);
    expect(file.credentials).toHaveLength(1);
    expect(file.credentials.at(0)?.accessToken).toBe("new-token");
  });

  test("findCredentialByOrgId matches on the exact (serverUrl, orgId) pair", () => {
    const credential = buildCredential();
    const file = upsertCredential(empty, credential);
    expect(
      findCredentialByOrgId(file, credential.serverUrl, credential.orgId),
    ).toEqual(credential);
    expect(
      findCredentialByOrgId(file, credential.serverUrl, "other-org"),
    ).toBeUndefined();
  });

  test("findCredentialByOrgHint matches by orgId or by the unverified orgLabel", () => {
    const credential = buildCredential({ orgLabel: "acme" });
    const file = upsertCredential(empty, credential);
    expect(findCredentialByOrgHint(file, credential.serverUrl, "acme")).toEqual(
      credential,
    );
    expect(
      findCredentialByOrgHint(file, credential.serverUrl, credential.orgId),
    ).toEqual(credential);
    expect(
      findCredentialByOrgHint(file, credential.serverUrl, "nope"),
    ).toBeUndefined();
  });

  test("findDefaultCredential resolves via defaultOrgByServer", () => {
    const first = buildCredential({ orgId: "org-1" });
    const second = buildCredential({ orgId: "org-2" });
    const file = setDefaultOrg(
      upsertCredential(upsertCredential(empty, first), second),
      first.serverUrl,
      "org-2",
    );
    expect(findDefaultCredential(file, first.serverUrl)?.orgId).toBe("org-2");
  });

  test("listCredentialsForServer only returns credentials for that server", () => {
    const here = buildCredential({ serverUrl: "https://a.example" });
    const there = buildCredential({ serverUrl: "https://b.example" });
    const file = upsertCredential(upsertCredential(empty, here), there);
    expect(listCredentialsForServer(file, "https://a.example")).toEqual([here]);
  });

  test("removeCredential promotes another credential to default when the default is removed", () => {
    const first = buildCredential({ orgId: "org-1" });
    const second = buildCredential({ orgId: "org-2" });
    const file = upsertCredential(upsertCredential(empty, first), second);

    const afterRemoval = removeCredential(file, first.serverUrl, "org-1");
    expect(afterRemoval.credentials).toHaveLength(1);
    expect(afterRemoval.defaultOrgByServer[first.serverUrl]).toBe("org-2");
  });

  test("removeCredential clears the default when no credential remains for that server", () => {
    const credential = buildCredential();
    const file = upsertCredential(empty, credential);
    const afterRemoval = removeCredential(
      file,
      credential.serverUrl,
      credential.orgId,
    );
    expect(afterRemoval.credentials).toHaveLength(0);
    expect(
      afterRemoval.defaultOrgByServer[credential.serverUrl],
    ).toBeUndefined();
  });

  test("removeCredential leaves the default alone when removing a non-default org", () => {
    const first = buildCredential({ orgId: "org-1" });
    const second = buildCredential({ orgId: "org-2" });
    const file = upsertCredential(upsertCredential(empty, first), second);
    const afterRemoval = removeCredential(file, first.serverUrl, "org-2");
    expect(afterRemoval.defaultOrgByServer[first.serverUrl]).toBe("org-1");
  });
});
