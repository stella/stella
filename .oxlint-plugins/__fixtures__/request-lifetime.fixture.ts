// Passive regression fixture for `request-lifetime/confine-request-reads`.

import { Result } from "better-result";

type Send = { request: Request };

const preflight = async ({
  isClientConnectionAborted,
}: {
  isClientConnectionAborted: () => boolean;
}) =>
  await Result.gen(async function* () {
    // Allowed: `Result.gen` runs its callback before `preflight` returns.
    // expect-clean: request-lifetime/confine-request-reads
    if (isClientConnectionAborted()) {
      return Result.err("gone" as const);
    }
    await Promise.resolve();
    yield* Result.ok(undefined);
    return Result.ok("ready" as const);
  });

export const send = async ({ request }: Send) => {
  // Allowed: the one place the request is read.
  // expect-clean: request-lifetime/confine-request-reads
  const isClientConnectionAborted = () => request.signal.aborted;
  // Allowed: asked while the send still runs.
  // expect-clean: request-lifetime/confine-request-reads
  if (isClientConnectionAborted()) {
    return null;
  }
  // Allowed: handed on under its own name to a function that receives it.
  // expect-clean: request-lifetime/confine-request-reads
  await preflight({ isClientConnectionAborted });

  // MUST flag: the request read anywhere but the probe.
  // oxlint-disable-next-line request-lifetime/confine-request-reads -- fixture: a direct read of the request
  const agent = request.headers.get("user-agent");

  // MUST flag: a closure that asks the probe after the send has returned.
  // oxlint-disable-next-line request-lifetime/confine-request-reads -- fixture: the probe captured by a later callback
  const onFinish = () => isClientConnectionAborted();

  // MUST flag: the probe handed on under another name.
  // oxlint-disable-next-line request-lifetime/confine-request-reads -- fixture: the probe escapes under an alias
  const escaped = { aborted: isClientConnectionAborted };

  return { agent, escaped, onFinish };
};

// MUST flag: the request read through its context.
// oxlint-disable-next-line request-lifetime/confine-request-reads -- fixture: a `.request` member read
export const urlOf = (ctx: Send) => ctx.request.url;
