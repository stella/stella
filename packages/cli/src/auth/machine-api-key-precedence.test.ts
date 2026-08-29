import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { upsertCredential, writeCredentialFile } from "./credential-store.js";
import type { StoredCredential } from "./credential-store.js";
import { resolveAccessToken } from "./resolve-access-token.js";

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
 * The env tier is injected per call, so the ambient shell never reaches the
 * test.
 */
const envWith = (STELLA_API_KEY: string | undefined) => ({ STELLA_API_KEY });

const SERVER_URL = "https://stella.example";
const MACHINE_KEY = "stella_mk_test-machine-credential";

describe("resolveAccessToken with STELLA_API_KEY", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "stella-machine-key-"));
  });

  afterEach(async () => {
    await rm(configDir, { force: true, recursive: true });
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
    await seedCredential();

    const resolved = await resolveAccessToken({
      configDir,
      serverUrl: SERVER_URL,
      env: envWith(MACHINE_KEY),
    });

    expect(resolved).toEqual({ status: "ok", token: MACHINE_KEY });
  });

  test("does not fall back to the stored credential when the machine key is expired or rejected", async () => {
    // The CLI cannot tell a good key from a bad one locally — it is an opaque
    // secret the server validates. So "rejected" is modelled the only way it can
    // be observed here: whatever the key's fate, resolution must not consult
    // disk. A fallback would surface as the human token leaking through.
    await seedCredential();

    const resolved = await resolveAccessToken({
      configDir,
      serverUrl: SERVER_URL,
      env: envWith("stella_mk_revoked-or-expired"),
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
    await seedCredential({ expiresAt: Date.now() - 10_000 });

    const resolved = await resolveAccessToken({
      configDir,
      serverUrl: SERVER_URL,
      env: envWith(MACHINE_KEY),
    });

    expect(resolved).toEqual({ status: "ok", token: MACHINE_KEY });
  });

  test("falls back to the stored credential when the variable is set but empty", async () => {
    // An unset variable and one exported as "" are the same intent; a shell that
    // exports `STELLA_API_KEY=` must not lock the CLI out of its stored login.
    await seedCredential();

    const resolved = await resolveAccessToken({
      configDir,
      serverUrl: SERVER_URL,
      env: envWith(""),
    });

    expect(resolved).toEqual({ status: "ok", token: "human-access-token" });
  });

  test("reports unauthenticated rather than a machine key when neither is present", async () => {
    const resolved = await resolveAccessToken({
      configDir,
      serverUrl: SERVER_URL,
      env: envWith(undefined),
    });

    expect(resolved).toEqual({ status: "unauthenticated" });
  });
});
