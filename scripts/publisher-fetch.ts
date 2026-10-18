#!/usr/bin/env bun
import { Result, TaggedError } from "better-result";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  createPolitePublisherFetch,
  readBoundedBody,
} from "@stll/fetch/publisher";
import { sha256Hex } from "@stll/sha256/bun";

import {
  OUTBOUND_PROTOCOL_POLICY,
  validateOutboundFetchTarget,
} from "@/api/lib/safe-outbound-fetch";

const usage = "Usage: bun scripts/publisher-fetch.ts <url> --archive <dir>";
const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
const BODY_TIMEOUT_MS = 5 * 60_000;
class PublisherFetchCliError extends TaggedError("PublisherFetchCliError")<{
  message: string;
}> {}
const politePublisherFetch = createPolitePublisherFetch({
  validateTarget: async (url) => {
    const target = await validateOutboundFetchTarget(url, {
      protocolPolicy: OUTBOUND_PROTOCOL_POLICY.HTTP_AND_HTTPS,
    });
    return target.map(({ url: validatedUrl }) => validatedUrl);
  },
});

const run = async () => {
  const [rawUrl, archiveFlag, archiveDir, ...rest] = Bun.argv.slice(2);
  if (
    !rawUrl ||
    archiveFlag !== "--archive" ||
    !archiveDir ||
    rest.length > 0
  ) {
    throw new PublisherFetchCliError({ message: usage });
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PublisherFetchCliError({
      message: "Publisher target must use http or https",
    });
  }
  const requestedAt = new Date().toISOString();
  const outcome = await politePublisherFetch(url);
  if (Result.isError(outcome)) {
    process.stderr.write(`${outcome.error._tag}: ${outcome.error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const body = await Result.tryPromise(async () =>
    readBoundedBody(outcome.value.response, {
      maxBytes: ARCHIVE_MAX_BYTES,
      signal: AbortSignal.timeout(BODY_TIMEOUT_MS),
    }),
  );
  if (Result.isError(body)) {
    process.stderr.write(`body_unreadable: ${String(body.error.cause)}\n`);
    process.exitCode = 2;
    return;
  }
  if (Result.isError(body.value)) {
    process.stderr.write(
      `${body.value.error._tag}: ${body.value.error.message}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const bytes = body.value.value;
  const hash = sha256Hex(bytes);
  const leaf = path.basename(url.pathname) || "index";
  const bodyFile = `${hash}-${leaf.replaceAll(/[^a-zA-Z0-9._-]/gu, "_")}`;
  await mkdir(archiveDir, { recursive: true });
  await Bun.write(path.join(archiveDir, bodyFile), bytes);
  await Bun.write(
    path.join(archiveDir, `${bodyFile}.sha256.json`),
    `${JSON.stringify({ algorithm: "sha256", sha256: hash, file: bodyFile, url: url.href })}\n`,
  );
  await appendFile(
    path.join(archiveDir, "requests.ndjson"),
    `${JSON.stringify({
      url: url.href,
      time: requestedAt,
      status: outcome.value.response.status,
      robotsDecision: outcome.value.robotsDecision,
      delayAppliedMs: outcome.value.delayAppliedMs,
    })}\n`,
  );
};

if (import.meta.main) {
  await run();
}
