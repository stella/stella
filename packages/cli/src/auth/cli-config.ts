// Non-secret CLI configuration: the default server origin and, per server,
// the dynamically-registered OAuth client id (a public client id is not a
// secret; there is no client_secret for `token_endpoint_auth_method: "none"`
// clients). Stored separately from `credential-store.ts`'s file, which holds
// tokens and is mode 0600.

import { Result } from "better-result";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import { defaultConfigDir, resolveConfigDir } from "./config-dir.js";
import type { ConfigPathOverrides } from "./config-dir.js";

export { defaultConfigDir, resolveConfigDir };
export type { ConfigPathOverrides };

// Hand-written rather than `v.InferOutput<typeof schema>`: this package
// builds with `isolatedDeclarations` (it is a publishable `@stll` package),
// which requires every module-scope binding reachable from an exported
// symbol to carry an explicit type. Decoupling the wire schema from the
// domain type also means a schema/type drift shows up as a type error at
// the `v.parse`/`v.safeParse` call site instead of silently at the alias.
export type CliConfig = {
  readonly version: 1;
  readonly defaultServerUrl?: string | undefined;
  readonly oauthClients: Readonly<Record<string, RegisteredOAuthClient>>;
};

export type RegisteredOAuthClient = {
  readonly clientId: string;
  readonly registeredAt: number;
  /** Missing only on config entries written before scope-aware registration. */
  readonly registeredScopes?: readonly string[] | undefined;
};

const oauthClientEntrySchema = v.strictObject({
  clientId: v.string(),
  registeredAt: v.number(),
  registeredScopes: v.optional(v.array(v.string())),
});

const cliConfigSchema = v.strictObject({
  version: v.literal(1),
  defaultServerUrl: v.optional(v.string()),
  oauthClients: v.record(v.string(), oauthClientEntrySchema),
});

const EMPTY_CONFIG: CliConfig = { oauthClients: {}, version: 1 };

export const configFilePath = (configDir: string): string =>
  path.join(configDir, "config.json");

export const readCliConfig = async (configDir: string): Promise<CliConfig> => {
  // A missing, corrupt, or empty config file must degrade to defaults, not
  // crash every CLI invocation at context construction.
  const raw = await Result.tryPromise(
    async () => await readFile(configFilePath(configDir), "utf-8"),
  );
  if (Result.isError(raw)) {
    return EMPTY_CONFIG;
  }
  const parsedJson = Result.try((): unknown => JSON.parse(raw.value));
  if (Result.isError(parsedJson)) {
    return EMPTY_CONFIG;
  }
  const parsed = v.safeParse(cliConfigSchema, parsedJson.value);
  return parsed.success ? parsed.output : EMPTY_CONFIG;
};

export const writeCliConfig = async (
  configDir: string,
  config: CliConfig,
): Promise<void> => {
  // `Bun.write` created the parent directory implicitly; `node:fs` `writeFile`
  // does not. Mirror `credential-store.ts`'s 0700 config dir (both files live
  // in the same `~/.config/stella` directory).
  await mkdir(configDir, { mode: 0o700, recursive: true });
  await writeFile(
    configFilePath(configDir),
    `${JSON.stringify(config, null, 2)}\n`,
  );
};

export const setDefaultServerUrl = async (
  configDir: string,
  serverUrl: string,
): Promise<void> => {
  const config = await readCliConfig(configDir);
  await writeCliConfig(configDir, { ...config, defaultServerUrl: serverUrl });
};

export const getRegisteredClient = async (
  configDir: string,
  serverUrl: string,
): Promise<RegisteredOAuthClient | undefined> => {
  const config = await readCliConfig(configDir);
  return config.oauthClients[serverUrl];
};

export const registeredClientSupportsScopes = (
  client: RegisteredOAuthClient,
  scopes: readonly string[],
): boolean => {
  const registeredScopes = client.registeredScopes;
  if (registeredScopes === undefined) {
    return false;
  }
  return scopes.every((scope) => registeredScopes.includes(scope));
};

export const setRegisteredClient = async (
  configDir: string,
  serverUrl: string,
  clientId: string,
  registeredScopes: readonly string[],
): Promise<void> => {
  const config = await readCliConfig(configDir);
  await writeCliConfig(configDir, {
    ...config,
    oauthClients: {
      ...config.oauthClients,
      [serverUrl]: { clientId, registeredAt: Date.now(), registeredScopes },
    },
  });
};
