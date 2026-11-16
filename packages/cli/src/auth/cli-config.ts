import { Result } from "better-result";
// Non-secret CLI configuration: the default server origin. Stored separately
// from `credential-store.ts`'s file, which holds tokens and is mode 0600.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

// Hand-written rather than `v.InferOutput<typeof schema>`: this package
// builds with `isolatedDeclarations` (it is a publishable `@stll` package),
// which requires every module-scope binding reachable from an exported
// symbol to carry an explicit type. Decoupling the wire schema from the
// domain type also means a schema/type drift shows up as a type error at
// the `v.parse`/`v.safeParse` call site instead of silently at the alias.
export type CliConfig = {
  readonly version: 1;
  readonly defaultServerUrl?: string | undefined;
};

// Not strict: files written by earlier CLI versions also hold the OAuth
// clients those versions registered, which nothing reads any more and the
// next write drops.
const cliConfigSchema = v.object({
  version: v.literal(1),
  defaultServerUrl: v.optional(v.string()),
});

const EMPTY_CONFIG: CliConfig = { version: 1 };

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
