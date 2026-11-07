#!/usr/bin/env bun
import { Result, TaggedError } from "better-result";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  createPolitePublisherFetch,
  readBoundedBody,
} from "@stll/fetch/publisher";
import { sha256Hex } from "@stll/sha256/bun";

import { fetchStreamWithResolvedAddress } from "@/api/lib/auth/authorized-outbound-fetch";
import {
  grantThirdPartyOutboundPermit,
  type ThirdPartyOutboundPermit,
} from "@/api/lib/auth/third-party-outbound-permit";
import {
  OUTBOUND_PROTOCOL_POLICY,
  validateOutboundFetchTarget,
} from "@/api/lib/safe-outbound-fetch";

const usage = "Usage: bun scripts/publisher-fetch.ts <url> --archive <dir>";
const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
// One deadline covers the pacing wait, response headers and the body.
const FETCH_TIMEOUT_MS = 5 * 60_000;
const HEADER_TIMEOUT_MS = 30_000;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
class PublisherFetchCliError extends TaggedError("PublisherFetchCliError")<{
  message: string;
}> {}
type PublisherFetchFactoryOptions = {
  permit: ThirdPartyOutboundPermit;
  resolveAddresses?: NonNullable<
    Parameters<typeof validateOutboundFetchTarget>[1]
  >["resolveAddresses"];
  headerTimeoutMs?: number;
};

export const createPublisherFetch = ({
  permit,
  resolveAddresses,
  headerTimeoutMs = HEADER_TIMEOUT_MS,
}: PublisherFetchFactoryOptions) =>
  createPolitePublisherFetch({
    validateTarget: async (url) =>
      await validateOutboundFetchTarget(url, {
        protocolPolicy: OUTBOUND_PROTOCOL_POLICY.HTTP_AND_HTTPS,
        ...(resolveAddresses ? { resolveAddresses } : {}),
      }),
    fetcher: async (target, init) => {
      // The archive CLI only reads; refusing a body beats sending it empty.
      if (init?.body !== undefined && init.body !== null) {
        throw new PublisherFetchCliError({
          message: "The publisher CLI transport does not send request bodies",
        });
      }
      const fetched = await fetchStreamWithResolvedAddress({
        addresses: target.addresses,
        headers: new Headers(init?.headers),
        maxBytes: ARCHIVE_MAX_BYTES,
        method: init?.method,
        permit,
        redirect: "manual",
        signal: init?.signal ?? undefined,
        timeoutMs: headerTimeoutMs,
        url: target.url,
      });
      if (Result.isError(fetched)) {
        throw fetched.error;
      }
      const body = NULL_BODY_STATUSES.has(fetched.value.status)
        ? null
        : fetched.value.body;
      if (body === null) {
        await fetched.value.body.cancel();
      }
      return new Response(body, {
        headers: fetched.value.headers,
        status: fetched.value.status,
      });
    },
  });

const politePublisherFetch = createPublisherFetch({
  permit: grantThirdPartyOutboundPermit(),
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
  const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const outcome = await Result.tryPromise(async () =>
    politePublisherFetch(url, { init: { signal: deadline } }),
  );
  if (Result.isError(outcome)) {
    process.stderr.write(`request_failed: ${String(outcome.error.cause)}\n`);
    process.exitCode = 2;
    return;
  }
  if (Result.isError(outcome.value)) {
    const refusal = outcome.value.error;
    process.stderr.write(`${refusal._tag}: ${refusal.message}\n`);
    process.exitCode = 2;
    return;
  }
  const fetched = outcome.value.value;
  const body = await Result.tryPromise(async () =>
    readBoundedBody(fetched.response, {
      maxBytes: ARCHIVE_MAX_BYTES,
      signal: deadline,
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
      status: fetched.response.status,
      robotsDecision: fetched.robotsDecision,
      delayAppliedMs: fetched.delayAppliedMs,
    })}\n`,
  );
};

if (import.meta.main) {
  await run();
}
