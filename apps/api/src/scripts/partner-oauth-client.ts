/**
 * Usage:
 *   bun /app/partner-oauth-client.js create --name <name> --redirect-uri <uri> [--redirect-uri <uri> ...]
 *   bun /app/partner-oauth-client.js rotate --client-id <id>
 *   bun /app/partner-oauth-client.js disable --client-id <id>
 *
 * Registers, rotates, or disables a partner client: one confidential OAuth
 * client for a hosted assistant that cannot register itself. `create` and
 * `rotate` print the client secret once, so they run only on a terminal.
 */
import { Result } from "better-result";
import { parseArgs } from "node:util";
import * as v from "valibot";

import {
  changePartnerOAuthClient,
  createPartnerOAuthClient,
} from "@/api/db/root";
import { PartnerClientOperatorError } from "@/api/lib/db/partner-client-operator";
import { getMcpResourceUrl } from "@/api/mcp/constants";

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    name: { type: "string" },
    "redirect-uri": { type: "string", multiple: true },
    "client-id": { type: "string" },
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
if (
  (operation === "create" || operation === "rotate") &&
  !process.stdout.isTTY
) {
  throw new PartnerClientOperatorError({
    message:
      "Run in an interactive terminal: the client secret is displayed once.",
  });
}

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
      }),
      values,
    );
    return await createPartnerOAuthClient({
      name: input.name,
      redirectUris: input["redirect-uri"],
      mcpResourceUrl: getMcpResourceUrl(),
    });
  }
  const input = v.parse(
    v.strictObject({
      "client-id": v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    }),
    values,
  );
  return await changePartnerOAuthClient({
    clientId: input["client-id"],
    operation,
  });
});
if (Result.isError(result)) {
  // Do not print database errors: their parameters may contain credential material.
  process.stderr.write(
    "Partner client operation failed; no credentials were displayed.\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(result.value)}\n`);
}
