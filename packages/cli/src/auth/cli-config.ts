// Non-secret CLI configuration: the default server origin and, per server,
// the dynamically-registered OAuth client id (a public client id is not a
// secret; there is no client_secret for `token_endpoint_auth_method: "none"`
// clients). Stored separately from `credential-store.ts`'s file, which holds
// tokens and is mode 0600.

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
  readonly oauthClients: Readonly<
    Record<string, { readonly clientId: string; readonly registeredAt: number }>
  >;
};

const oauthClientEntrySchema = v.strictObject({
  clientId: v.string(),
  registeredAt: v.number(),
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
  const file = Bun.file(configFilePath(configDir));
  if (!(await file.exists())) {
    return EMPTY_CONFIG;
  }

  // A corrupt or empty config file must degrade to defaults, not crash
  // every CLI invocation at context construction.
  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    return EMPTY_CONFIG;
  }
  const parsed = v.safeParse(cliConfigSchema, raw);
  return parsed.success ? parsed.output : EMPTY_CONFIG;
};

export const writeCliConfig = async (
  configDir: string,
  config: CliConfig,
): Promise<void> => {
  await Bun.write(
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

export const getRegisteredClientId = async (
  configDir: string,
  serverUrl: string,
): Promise<string | undefined> => {
  const config = await readCliConfig(configDir);
  return config.oauthClients[serverUrl]?.clientId;
};

export const setRegisteredClientId = async (
  configDir: string,
  serverUrl: string,
  clientId: string,
): Promise<void> => {
  const config = await readCliConfig(configDir);
  await writeCliConfig(configDir, {
    ...config,
    oauthClients: {
      ...config.oauthClients,
      [serverUrl]: { clientId, registeredAt: Date.now() },
    },
  });
};
