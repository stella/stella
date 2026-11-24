import { Result } from "better-result";

import { argumentsBeforeTerminator } from "./command-locality.js";
import {
  checkServerCompatibility,
  type CompatibilityCheckError,
  type CompatibilityReport,
  validateCompatibility,
} from "./compatibility.js";
import {
  CACHE_SCHEMA_VERSION,
  type CacheEnv,
  cachePathFor,
  DEFAULT_TTL_SECONDS,
  readCacheFile,
  writeCacheFile,
} from "./registry-cache.js";

/** Local inspection and recovery must remain available against an incompatible server. */
export const commandNeedsCompatibility = (argv: readonly string[]): boolean => {
  const commandArguments = argumentsBeforeTerminator(argv);
  const command = argv.at(0);
  return (
    command !== undefined &&
    !commandArguments.some((arg) =>
      ["--help", "-h", "--version", "--schema"].includes(arg),
    ) &&
    !["help", "update", "doctor", "compatibility"].includes(command) &&
    !(
      command === "auth" &&
      ["logout", "switch"].includes(commandArguments.at(1) ?? "")
    ) &&
    !(command === "tools" && commandArguments.at(1) === "list")
  );
};

type CheckCommandCompatibilityOptions = {
  serverUrl: string;
  env: CacheEnv;
  now: number;
};

export const checkCommandCompatibility = async ({
  serverUrl,
  env,
  now,
}: CheckCommandCompatibilityOptions): Promise<
  Result<CompatibilityReport, CompatibilityCheckError>
> => {
  const filePath = cachePathFor(serverUrl, env);
  const cachedRead = await readCacheFile(filePath);
  const cached = cachedRead.status === "ok" ? cachedRead.file : undefined;
  const evidence = cached?.compatibility;
  if (
    cached?.serverOrigin === serverUrl &&
    evidence !== undefined &&
    now >= evidence.checkedAt &&
    now - evidence.checkedAt < DEFAULT_TTL_SECONDS * 1000
  ) {
    return validateCompatibility(evidence.metadata, serverUrl);
  }
  // The cached evidence only saves a later discovery request: a cache that
  // cannot be written must not refuse a command whose server is compatible.
  return checkServerCompatibility(serverUrl, async (metadata) => {
    const saved = await Result.tryPromise(
      async () =>
        await writeCacheFile(filePath, {
          ...(cached ?? {
            version: CACHE_SCHEMA_VERSION,
            serverOrigin: serverUrl,
            fetchedAt: new Date(0).toISOString(),
            ttlSeconds: DEFAULT_TTL_SECONDS,
          }),
          compatibility: { checkedAt: now, metadata },
        }),
    );
    if (saved.isErr()) {
      process.stderr.write(
        "Compatibility cache could not be saved; a later command checks the server again.\n",
      );
    }
  });
};
