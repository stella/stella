// Everything a successful `stella auth login` must persist, in one call: the
// credential, the server's default org, and the default server URL. They were
// three independent writes and the last one was simply never made, so every
// later command failed with "No server configured" until `--server` was passed
// again. Keeping them in one function is what makes that state unreachable.

import { Result } from "better-result";

import { readCliConfig, writeCliConfig } from "./cli-config.js";
import {
  setDefaultOrg,
  updateCredentialFile,
  upsertCredential,
} from "./credential-store.js";
import type { StoredCredential } from "./credential-store.js";
import { TokenExchangeError } from "./errors.js";
import type { CliAuthError } from "./errors.js";

// The credential already names its server and org; taking them as separate
// arguments would let a caller persist a default that disagrees with it.
export const persistLogin = async ({
  configDir,
  credential,
}: {
  readonly configDir: string;
  readonly credential: StoredCredential;
}): Promise<Result<void, CliAuthError>> => {
  const updated = await updateCredentialFile(configDir, (file) => ({
    status: "updated",
    value: undefined,
    file: setDefaultOrg(
      upsertCredential(file, credential),
      credential.serverUrl,
      credential.orgId,
    ),
  }));

  if (updated.isErr()) {
    return updated;
  }
  return await Result.tryPromise({
    try: async () => {
      const config = await readCliConfig(configDir);
      await writeCliConfig(configDir, {
        ...config,
        defaultServerUrl: credential.serverUrl,
      });
    },
    catch: (cause) =>
      new TokenExchangeError({
        message:
          "Could not persist the default server after login. Check the configuration directory permissions and retry.",
        cause,
      }),
  });
};
