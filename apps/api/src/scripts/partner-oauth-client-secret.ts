/**
 * Usage (operator's machine, never a server task):
 *   bun run oauth:partner-client-secret
 *
 * Mints a partner client secret and prints it with its digest. The secret goes
 * straight to the partner's credential store; only `clientSecretSha256` goes
 * to `partner-oauth-client.js create|rotate --secret-sha256`. Loads no server
 * configuration, so it runs on any machine.
 */
import { mintPartnerClientSecret } from "@/api/lib/db/partner-client-contract";

// An ECS task records its session output; the secret must never be in it.
const isEcsTask = process.env["ECS_CONTAINER_METADATA_URI_V4"] !== undefined;

if (isEcsTask || !process.stdout.isTTY) {
  process.stderr.write(
    "Run this in an interactive terminal on your own machine, never in a server task: it displays the client secret.\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(mintPartnerClientSecret())}\n`);
}
