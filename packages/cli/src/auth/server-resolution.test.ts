import { Result } from "better-result";
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

import { writeCliConfig } from "./cli-config.js";

// `resolveServerUrl` sits in front of nearly every command, so its precedence
// (flag > env var > saved config > error) is a real correctness surface. The
// env var is read via the module-scoped `../env.js` binding, so it is re-mocked
// per test to control the middle tier deterministically regardless of the
// ambient shell environment.
const setEnvServerUrl = (value: string | undefined): void => {
  void mock.module("../env.js", () => ({
    HOME: undefined,
    STELLA_SERVER_URL: value,
    XDG_CACHE_HOME: undefined,
    XDG_CONFIG_HOME: undefined,
  }));
};

setEnvServerUrl(undefined);
const { resolveServerUrl } = await import("./server-resolution.js");

// `mock.module` is process-wide: `bun test src` runs every CLI test file in one
// process, so leaving `../env.js` mocked after this file finishes would leak the
// fake environment into any later file that imports `env.js` or
// `server-resolution.js`. Restore the real module once this file's tests are done.
afterAll(() => {
  mock.restore();
});

const configWith = (defaultServerUrl: string) => ({
  defaultServerUrl,
  oauthClients: {},
  version: 1 as const,
});

describe("resolveServerUrl precedence", () => {
  let configDir: string;

  beforeEach(async () => {
    setEnvServerUrl(undefined);
    configDir = await mkdtemp(path.join(os.tmpdir(), "stella-cli-server-res-"));
  });

  afterEach(async () => {
    await rm(configDir, { force: true, recursive: true });
  });

  test("the --server flag wins over env var and config", async () => {
    setEnvServerUrl("https://env.example");
    await writeCliConfig(configDir, configWith("https://config.example"));

    const result = await resolveServerUrl(configDir, "https://flag.example");
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toBe("https://flag.example");
    }
  });

  test("the env var wins over saved config when no flag is passed", async () => {
    setEnvServerUrl("https://env.example");
    await writeCliConfig(configDir, configWith("https://config.example"));

    const result = await resolveServerUrl(configDir, undefined);
    if (Result.isOk(result)) {
      expect(result.value).toBe("https://env.example");
    } else {
      throw new TypeError("expected ok");
    }
  });

  test("falls back to saved config when neither flag nor env is set", async () => {
    await writeCliConfig(configDir, configWith("https://config.example"));

    const result = await resolveServerUrl(configDir, undefined);
    if (Result.isOk(result)) {
      expect(result.value).toBe("https://config.example");
    } else {
      throw new TypeError("expected ok");
    }
  });

  test("errors when nothing configures a server", async () => {
    const result = await resolveServerUrl(configDir, undefined);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("ServerUrlNotConfiguredError");
    }
  });
});

describe("resolveServerUrl normalization", () => {
  let configDir: string;

  beforeEach(async () => {
    setEnvServerUrl(undefined);
    configDir = await mkdtemp(
      path.join(os.tmpdir(), "stella-cli-server-norm-"),
    );
  });

  afterEach(async () => {
    await rm(configDir, { force: true, recursive: true });
  });

  test("strips a single trailing slash from the flag value", async () => {
    const result = await resolveServerUrl(configDir, "https://stella.example/");
    if (Result.isOk(result)) {
      expect(result.value).toBe("https://stella.example");
    } else {
      throw new TypeError("expected ok");
    }
  });

  test("preserves a path segment, stripping only the trailing slash", async () => {
    // Split-host / sub-path deployments (`advanced.basePath`) keep their path;
    // normalization must not collapse it to the origin.
    const result = await resolveServerUrl(
      configDir,
      "https://stella.example/api/",
    );
    if (Result.isOk(result)) {
      expect(result.value).toBe("https://stella.example/api");
    } else {
      throw new TypeError("expected ok");
    }
  });

  test("normalizes a value coming from the env tier too", async () => {
    setEnvServerUrl("https://env.example/");
    const result = await resolveServerUrl(configDir, undefined);
    if (Result.isOk(result)) {
      expect(result.value).toBe("https://env.example");
    } else {
      throw new TypeError("expected ok");
    }
  });
});
