import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeCliConfig } from "./cli-config.js";
import { resolveServerUrl } from "./server-resolution.js";

// `resolveServerUrl` sits in front of nearly every command, so its precedence
// (flag > env var > saved config > error) is a real correctness surface. The
// env tier is injected per call, so the ambient shell never reaches the test.
const envWith = (STELLA_SERVER_URL: string | undefined) => ({
  STELLA_SERVER_URL,
});
const NO_ENV = envWith(undefined);

const configWith = (defaultServerUrl: string) => ({
  defaultServerUrl,
  oauthClients: {},
  version: 1 as const,
});

describe("resolveServerUrl precedence", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "stella-cli-server-res-"));
  });

  afterEach(async () => {
    await rm(configDir, { force: true, recursive: true });
  });

  test("the --server flag wins over env var and config", async () => {
    await writeCliConfig(configDir, configWith("https://config.example"));

    const result = await resolveServerUrl({
      configDir,
      flagValue: "https://flag.example",
      env: envWith("https://env.example"),
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toBe("https://flag.example");
    }
  });

  test("the env var wins over saved config when no flag is passed", async () => {
    await writeCliConfig(configDir, configWith("https://config.example"));

    const result = await resolveServerUrl({
      configDir,
      flagValue: undefined,
      env: envWith("https://env.example"),
    });
    if (Result.isOk(result)) {
      expect(result.value).toBe("https://env.example");
    } else {
      throw new TypeError("expected ok");
    }
  });

  test("falls back to saved config when neither flag nor env is set", async () => {
    await writeCliConfig(configDir, configWith("https://config.example"));

    const result = await resolveServerUrl({
      configDir,
      flagValue: undefined,
      env: NO_ENV,
    });
    if (Result.isOk(result)) {
      expect(result.value).toBe("https://config.example");
    } else {
      throw new TypeError("expected ok");
    }
  });

  test("errors when nothing configures a server", async () => {
    const result = await resolveServerUrl({
      configDir,
      flagValue: undefined,
      env: NO_ENV,
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("ServerUrlNotConfiguredError");
    }
  });
});

describe("resolveServerUrl normalization", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(
      path.join(os.tmpdir(), "stella-cli-server-norm-"),
    );
  });

  afterEach(async () => {
    await rm(configDir, { force: true, recursive: true });
  });

  test("strips a single trailing slash from the flag value", async () => {
    const result = await resolveServerUrl({
      configDir,
      flagValue: "https://stella.example/",
      env: NO_ENV,
    });
    if (Result.isOk(result)) {
      expect(result.value).toBe("https://stella.example");
    } else {
      throw new TypeError("expected ok");
    }
  });

  test("preserves a path segment, stripping only the trailing slash", async () => {
    // Split-host / sub-path deployments (`advanced.basePath`) keep their path;
    // normalization must not collapse it to the origin.
    const result = await resolveServerUrl({
      configDir,
      flagValue: "https://stella.example/api/",
      env: NO_ENV,
    });
    if (Result.isOk(result)) {
      expect(result.value).toBe("https://stella.example/api");
    } else {
      throw new TypeError("expected ok");
    }
  });

  test("normalizes a value coming from the env tier too", async () => {
    const result = await resolveServerUrl({
      configDir,
      flagValue: undefined,
      env: envWith("https://env.example/"),
    });
    if (Result.isOk(result)) {
      expect(result.value).toBe("https://env.example");
    } else {
      throw new TypeError("expected ok");
    }
  });
});
