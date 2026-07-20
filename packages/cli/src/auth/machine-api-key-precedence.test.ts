import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { upsertCredential, writeCredentialFile } from "./credential-store.js";
import type { StoredCredential } from "./credential-store.js";

/**
 * `STELLA_API_KEY` precedence. The thing worth testing here is not that the key
 * is forwarded — it is that a stored `credentials.json` can never influence a
 * run that set the variable.
 *
 * The failure this guards against is silent and serious: if a bad or expired
 * machine key fell back to disk, a CI job or agent would quietly execute as
 * whichever human was logged in on that machine, attributing machine actions to
 * a person and running with that person's (likely broader) authority.
 *
 * The env var is read through a module-scoped `../env.js` binding, so it is
 * re-mocked per test to stay independent of the ambient shell.
 */
const setEnvApiKey = (value: string | undefined): void => {
  void mock.module("../env.js", () => ({
    HOME: undefined,
    STELLA_API_KEY: value,
    STELLA_SERVER_URL: undefined,
    XDG_CACHE_HOME: undefined,
    XDG_CONFIG_HOME: undefined,
  }));
};

setEnvApiKey(undefined);
const { resolveAccessToken } = await import("./resolve-access-token.js");

// `mock.module` is process-wide and `bun test` runs every CLI file in one
// process, so the real `../env.js` has to be restored or a later file inherits
// this fake environment.
afterAll(() => {
  mock.restore();
});

const SERVER_URL = "https://stella.example";
const MACHINE_KEY = "stella_mk_test-machine-credential";

describe("resolveAccessToken with STELLA_API_KEY", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "stella-machine-key-"));
  });

  afterEach(async () => {
    await rm(configDir, { force: true, recursive: true });
    setEnvApiKey(undefined);
  });

  const seedCredential = async (
    overrides: Partial<StoredCredential> = {},
  ): Promise<void> => {
    await writeCredentialFile(
      configDir,
      upsertCredential(
        { credentials: [], defaultOrgByServer: {}, version: 1 },
        {
          accessToken: "human-access-token",
          clientId: "client-id",
          createdAt: 0,
          expiresAt: Date.now() + 3_600_000,
          orgId: "org-human",
          refreshToken: "human-refresh-token",
          scope: "openid stella:read",
          serverUrl: SERVER_URL,
          tokenType: "Bearer",
          updatedAt: 0,
          ...overrides,
        },
      ),
    );
  };

  test("uses the machine key instead of a perfectly valid stored credential", async () => {
    setEnvApiKey(MACHINE_KEY);
    await seedCredential();

    const resolved = await resolveAccessToken({
      configDir,
      serverUrl: SERVER_URL,
    });

    expect(resolved).toEqual({ status: "ok", token: MACHINE_KEY });
  });

  test("does not fall back to the stored credential when the machine key is expired or rejected", async () => {
    // The CLI cannot tell a good key from a bad one locally — it is an opaque
    // secret the server validates. So "rejected" is modelled the only way it can
    // be observed here: whatever the key's fate, resolution must not consult
    // disk. A fallback would surface as the human token leaking through.
    setEnvApiKey("stella_mk_revoked-or-expired");
    await seedCredential();

    const resolved = await resolveAccessToken({
      configDir,
      serverUrl: SERVER_URL,
    });

    expect(resolved).toEqual({
      status: "ok",
      token: "stella_mk_revoked-or-expired",
    });
  });

  test("never attempts a refresh, even when the stored credential is expired and refreshable", async () => {
    // With no machine key this credential would drive metadata discovery and a
    // token exchange against `SERVER_URL`, which does not resolve in tests. If
    // the short-circuit regressed, this test would fail on a network attempt
    // rather than quietly returning the wrong token.
    setEnvApiKey(MACHINE_KEY);
    await seedCredential({ expiresAt: Date.now() - 10_000 });

    const resolved = await resolveAccessToken({
      configDir,
      serverUrl: SERVER_URL,
    });

    expect(resolved).toEqual({ status: "ok", token: MACHINE_KEY });
  });

  test("falls back to the stored credential when the variable is set but empty", async () => {
    // An unset variable and one exported as "" are the same intent; a shell that
    // exports `STELLA_API_KEY=` must not lock the CLI out of its stored login.
    setEnvApiKey("");
    await seedCredential();

    const resolved = await resolveAccessToken({
      configDir,
      serverUrl: SERVER_URL,
    });

    expect(resolved).toEqual({ status: "ok", token: "human-access-token" });
  });

  test("reports unauthenticated rather than a machine key when neither is present", async () => {
    setEnvApiKey(undefined);

    const resolved = await resolveAccessToken({
      configDir,
      serverUrl: SERVER_URL,
    });

    expect(resolved).toEqual({ status: "unauthenticated" });
  });
});
