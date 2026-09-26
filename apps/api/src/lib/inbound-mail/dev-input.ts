import { Result, TaggedError } from "better-result";
import { isIP } from "node:net";
import { parseArgs } from "node:util";
import * as v from "valibot";

import { mailboxDomain } from "@/api/lib/inbound-mail/authentication";

export class InboundDevInputError extends TaggedError("InboundDevInputError")<{
  message: string;
}> {}

const inputSchema = v.object({
  file: v.pipe(v.string(), v.minLength(1)),
  "mail-from": v.pipe(v.string(), v.maxLength(1024)),
  "rcpt-to": v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(100)),
  "remote-ip": v.pipe(
    v.string(),
    v.check((value) => isIP(value) !== 0),
  ),
  helo: v.pipe(v.string(), v.minLength(1), v.maxLength(253)),
  "inbound-domain": v.pipe(
    v.string(),
    v.check(
      (value) => mailboxDomain(`receiver@${value}`) === value.toLowerCase(),
    ),
  ),
  "virus-verdict": v.picklist(["pass", "fail", "unavailable"]),
});

export const parseInboundDevInput = (args: string[]) => {
  const parsed = Result.try({
    try: () =>
      parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        options: {
          file: { type: "string" },
          "mail-from": { type: "string" },
          "rcpt-to": { type: "string", multiple: true },
          "remote-ip": { type: "string" },
          helo: { type: "string" },
          "inbound-domain": { type: "string" },
          "virus-verdict": { type: "string" },
        },
      }),
    catch: () =>
      new InboundDevInputError({ message: "Invalid inbound ingest arguments" }),
  });
  if (parsed.isErr()) {
    return parsed;
  }
  const validated = v.safeParse(inputSchema, parsed.value.values);
  if (!validated.success) {
    return Result.err(
      new InboundDevInputError({
        message: "Missing or invalid inbound ingest arguments",
      }),
    );
  }
  const input = validated.output;
  return Result.ok({
    file: input.file,
    inboundDomain: input["inbound-domain"],
    scan: input["virus-verdict"],
    envelope: {
      mailFrom: input["mail-from"],
      recipients: input["rcpt-to"],
      remoteIp: input["remote-ip"],
      helo: input.helo,
    },
  });
};
