import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { envApiServerSchema } from "../env-schema";

const nonModelKeys = new Set([
  "SECURITY_CANARY_API_KEY_SHA256",
  "TAVILY_API_KEY",
  "JINA_API_KEY",
  "COMPANIES_HOUSE_API_KEY",
  "HOSTED_USAGE_PROVIDER_API_KEY",
  "AGENT_SANDBOX_HARNESS_API_KEY",
]);
const credentialNames = Object.keys(envApiServerSchema).filter(
  (name) => name.includes("API_KEY") || name.startsWith("OPENROUTER_WIF_"),
);
const placeholder = "stella-test-provider-credential-0";
const preloadPath = new URL("setup-env.ts", import.meta.url).pathname;

const readPreloadedCredentials = (env: Record<string, string | undefined>) => {
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--no-env-file",
      "--preload",
      preloadPath,
      "-e",
      `console.log(JSON.stringify(${JSON.stringify(credentialNames)}.map(name => [name, process.env[name] ?? null])));`,
    ],
    cwd: new URL("../..", import.meta.url).pathname,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return JSON.parse(child.stdout.toString());
};

describe("API test preload credentials", () => {
  test("replaces every inherited model credential while preserving service keys", () => {
    const inherited = Object.fromEntries(
      credentialNames.map((name) => [name, `sk-inherited-${name}-1234567890`]),
    );
    expect(readPreloadedCredentials(inherited)).toEqual(
      credentialNames.map((name) => [
        name,
        nonModelKeys.has(name) ? inherited[name] : placeholder,
      ]),
    );
  });

  test("leaves absent credentials unset", () => {
    expect(readPreloadedCredentials({})).toEqual(
      credentialNames.map((name) => [name, null]),
    );
  });

  test("preserves set, empty and unset credentials in a partial configuration", () => {
    const valueAt = (name: string, index: number) => {
      if (index % 3 === 0) {
        return "";
      }
      return index % 3 === 1 ? `sk-inherited-${name}-1234567890` : undefined;
    };
    const inherited = Object.fromEntries(
      credentialNames.map((name, index) => [name, valueAt(name, index)]),
    );
    expect(readPreloadedCredentials(inherited)).toEqual(
      credentialNames.map((name, index) => {
        const value = valueAt(name, index);
        if (value === undefined) {
          return [name, null];
        }
        if (value === "" || nonModelKeys.has(name)) {
          return [name, value];
        }
        return [name, placeholder];
      }),
    );
  });

  test("keeps an empty model credential unconfigured", () => {
    const modelCredential = credentialNames.find(
      (name) => !nonModelKeys.has(name),
    );
    expect(modelCredential).toBeDefined();
    if (modelCredential === undefined) {
      return;
    }
    expect(readPreloadedCredentials({ [modelCredential]: "" })).toContainEqual([
      modelCredential,
      "",
    ]);
  });

  test("the placeholder remains valid for configured WIF fields", () => {
    expect(
      v.safeParse(
        v.pick(v.object(envApiServerSchema), [
          "OPENROUTER_WIF_POLICY_ID",
          "OPENROUTER_WIF_AUDIENCE",
          "OPENROUTER_WIF_STS_REGION",
        ]),
        {
          OPENROUTER_WIF_POLICY_ID: placeholder,
          OPENROUTER_WIF_AUDIENCE: placeholder,
          OPENROUTER_WIF_STS_REGION: placeholder,
        },
      ).success,
    ).toBe(true);
  });
});
