import * as v from "valibot";

import { skillRunnerInputSchema } from "@stll/api-contract/skill-runner";
import { fetchWithTimeout } from "@stll/fetch";
import { readBodyWithIdleDeadline } from "@stll/fetch/body-reader";

import { SkillRunnerArchiveError } from "./archive";
import { type ArchiveTransport, runSkillCommand } from "./run";

/** Until S3 answers with headers; the body then may not stall longer. */
const HEADERS_TIMEOUT_MS = 30_000;
const BODY_IDLE_MS = 30_000;
/** A workspace upload of up to the archive cap, at a slow but sane rate. */
const UPLOAD_TIMEOUT_MS = 300_000;

/** Presigned S3 URLs over HTTPS; a body larger than allowed is refused. */
const httpsTransport: ArchiveTransport = {
  get: async (url, maxBytes) => {
    const response = await fetchWithTimeout(url, {
      redirect: "error",
      timeout: { type: "headers", ms: HEADERS_TIMEOUT_MS },
    });
    if (!response.ok) {
      throw new SkillRunnerArchiveError({
        message: `Archive download failed with ${response.status}`,
      });
    }
    return await readBodyWithIdleDeadline(response, {
      idleMs: BODY_IDLE_MS,
      maxBytes,
    });
  },
  put: async (url, bytes) => {
    const response = await fetchWithTimeout(url, {
      method: "PUT",
      body: bytes,
      redirect: "error",
      headers: { "content-type": "application/zip" },
      timeout: { type: "total", ms: UPLOAD_TIMEOUT_MS },
    });
    await response.body?.cancel();
    if (!response.ok) {
      throw new SkillRunnerArchiveError({
        message: `Workspace upload failed with ${response.status}`,
      });
    }
  },
};

export const handler = async (event: unknown) => {
  const parsed = v.safeParse(skillRunnerInputSchema, event);
  if (!parsed.success) {
    throw new SkillRunnerArchiveError({ message: "Invalid skill run input" });
  }
  const ran = await runSkillCommand(parsed.output, httpsTransport);
  if (ran.isErr()) {
    throw ran.error;
  }
  return ran.value;
};
