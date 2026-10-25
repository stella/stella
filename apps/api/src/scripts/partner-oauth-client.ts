/**
 * Usage:
 *   (operator's machine) bun run oauth:partner-client-secret
 *   bun /app/partner-oauth-client.js create --name <name> --redirect-uri <uri> [--redirect-uri <uri> ...] --secret-sha256 <digest>
 *   bun /app/partner-oauth-client.js rotate --client-id <id> --secret-sha256 <digest>
 *   bun /app/partner-oauth-client.js disable --client-id <id>
 *
 * Registers, rotates, or disables a partner client: one confidential OAuth
 * client for a hosted assistant that cannot register itself. The client
 * secret is minted on the operator's machine (`partner-oauth-client-secret.ts`)
 * and handed straight to the partner; the server only ever receives its
 * digest, so no session, log or output of a server-side run contains the
 * secret.
 */
import { Result } from "better-result";
import { parseArgs } from "node:util";
import * as v from "valibot";

import {
  changePartnerOAuthClient,
  createPartnerOAuthClient,
} from "@/api/db/root";
import { PARTNER_CLIENT_SECRET_SHA256_PATTERN } from "@/api/lib/db/partner-client-contract";
import { PartnerClientOperatorError } from "@/api/lib/db/partner-client-operator";
import { getMcpResourceUrl } from "@/api/mcp/constants";

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    name: { type: "string" },
    "redirect-uri": { type: "string", multiple: true },
    "client-id": { type: "string" },
    "secret-sha256": { type: "string" },
  },
});
if (positionals.length !== 1) {
  throw new PartnerClientOperatorError({
    message: "Specify exactly one operation: create, rotate, or disable.",
  });
}
const operation = v.parse(
  v.picklist(["create", "rotate", "disable"]),
  positionals.at(0),
);

/** A partner's fixed https callback: no credentials, fragment, or loopback. */
const redirectUriSchema = v.pipe(
  v.string(),
  v.maxLength(2048),
  v.url(),
  v.check((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      url.protocol === "https:" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === "" &&
      url.hostname !== "localhost" &&
      !/^\[|^\d+\.\d+\.\d+\.\d+$/u.test(url.hostname)
    );
  }, "Redirect URIs must be https URLs on a public host without credentials or a fragment."),
);

const secretDigestSchema = v.pipe(
  v.string(),
  v.regex(
    PARTNER_CLIENT_SECRET_SHA256_PATTERN,
    "--secret-sha256 takes the clientSecretSha256 value that partner-oauth-client-secret printed.",
  ),
);

const clientIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

const result = await Result.tryPromise(async () => {
  if (operation === "create") {
    const input = v.parse(
      v.strictObject({
        name: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
        "redirect-uri": v.pipe(
          v.array(redirectUriSchema),
          v.minLength(1),
          v.maxLength(8),
        ),
        "secret-sha256": secretDigestSchema,
      }),
      values,
    );
    return await createPartnerOAuthClient({
      name: input.name,
      redirectUris: input["redirect-uri"],
      mcpResourceUrl: getMcpResourceUrl(),
      clientSecretSha256: input["secret-sha256"],
    });
  }
  if (operation === "rotate") {
    const input = v.parse(
      v.strictObject({
        "client-id": clientIdSchema,
        "secret-sha256": secretDigestSchema,
      }),
      values,
    );
    return await changePartnerOAuthClient({
      clientId: input["client-id"],
      operation,
      clientSecretSha256: input["secret-sha256"],
    });
  }
  const input = v.parse(
    v.strictObject({ "client-id": clientIdSchema }),
    values,
  );
  return await changePartnerOAuthClient({
    clientId: input["client-id"],
    operation,
  });
});
if (Result.isError(result)) {
  // Database errors are not printed: their parameters may carry the digest.
  process.stderr.write("Partner client operation failed.\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(result.value)}\n`);
}
