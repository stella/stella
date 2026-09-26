import { Result, TaggedError } from "better-result";

import { verifyMailLocally } from "@/api/lib/inbound-mail/authentication";
import { parseInboundDevInput } from "@/api/lib/inbound-mail/dev-input";
import { INBOUND_MAIL_LIMITS } from "@/api/lib/inbound-mail/limits";

const USAGE = `Development inbound ingest (NODE_ENV=development):
  bun scripts/ingest-mail.ts --file message.eml --mail-from member@example.test \\
    --rcpt-to TOKEN@inbound.example.test --remote-ip 192.0.2.1 --helo smtp.example.test \\
    --inbound-domain inbound.example.test --virus-verdict pass

Repeat --rcpt-to for multiple envelope recipients. Authentication is verified
locally against DNS and the supplied SMTP peer. Supply the actual trusted virus
scanner verdict (pass, fail, unavailable). No message header is trusted as a verdict.
`;

class InboundDevRunError extends TaggedError("InboundDevRunError")<{
  message: string;
}> {}

const run = async () => {
  if (process.argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  if (process.env.NODE_ENV !== "development") {
    throw new InboundDevRunError({
      message: "Inbound development ingest requires NODE_ENV=development",
    });
  }
  const input = parseInboundDevInput(process.argv.slice(2));
  if (input.isErr()) {
    throw input.error;
  }
  const file = Bun.file(input.value.file);
  if (file.size > INBOUND_MAIL_LIMITS.rawBytes) {
    throw new InboundDevRunError({
      message: "Inbound message exceeds the size limit",
    });
  }
  const raw = new Uint8Array(await file.arrayBuffer());
  const { receiveInboundMail } = await import("@/api/lib/inbound-mail/runtime");
  const result = await receiveInboundMail({
    raw,
    envelope: input.value.envelope,
    inboundDomain: input.value.inboundDomain,
    scan: input.value.scan,
    verify: verifyMailLocally,
    receivedAt: new Date().toISOString(),
  });
  if (result.isErr()) {
    throw result.error;
  }
  process.stdout.write(`${JSON.stringify(result.value)}\n`);
};

const result = await Result.tryPromise({
  try: run,
  catch: (cause) => cause,
});
if (result.isErr()) {
  // Do not print parser, database or transport errors containing message data.
  process.stderr.write(
    "Inbound ingest did not complete. Retain the source and retry. Use --help for arguments.\n",
  );
  process.exitCode = 1;
}
