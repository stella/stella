// Everything a successful `stella auth login` must persist, in one call: the
// credential, the server's default org, and the default server URL. They were
// three independent writes and the last one was simply never made, so every
// later command failed with "No server configured" until `--server` was passed
// again. Keeping them in one function is what makes that state unreachable.

import { readCliConfig, writeCliConfig } from "./cli-config.js";
import {
  setDefaultOrg,
  updateCredentialFile,
  upsertCredential,
} from "./credential-store.js";
import type { StoredCredential } from "./credential-store.js";

// The credential already names its server and org; taking them as separate
// arguments would let a caller persist a default that disagrees with it.
export const persistLogin = async ({
  configDir,
  credential,
}: {
  readonly configDir: string;
  readonly credential: StoredCredential;
}): Promise<void> => {
  await updateCredentialFile(configDir, (file) => ({
    status: "updated",
    value: undefined,
    file: setDefaultOrg(
      upsertCredential(file, credential),
      credential.serverUrl,
      credential.orgId,
    ),
  }));

  const config = await readCliConfig(configDir);
  await writeCliConfig(configDir, {
    ...config,
    defaultServerUrl: credential.serverUrl,
  });
};
