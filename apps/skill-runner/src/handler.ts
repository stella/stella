import * as v from "valibot";

import { skillRunnerInputSchema } from "@stll/api-contract/skill-runner";

import { SkillRunnerArchiveError } from "./archive";
import { type ArchiveTransport, runSkillCommand } from "./run";

/** One archive transfer may take this long; the command has its own timeout. */
const TRANSFER_TIMEOUT_MS = 120_000;

/** Presigned S3 URLs over HTTPS; a response larger than allowed is refused. */
const httpsTransport: ArchiveTransport = {
  get: async (url, maxBytes) => {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new SkillRunnerArchiveError({
        message: `Archive download failed with ${response.status}`,
      });
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      throw new SkillRunnerArchiveError({ message: "Archive is too large" });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new SkillRunnerArchiveError({ message: "Archive is too large" });
    }
    return bytes;
  },
  put: async (url, bytes) => {
    const response = await fetch(url, {
      method: "PUT",
      body: bytes,
      redirect: "error",
      headers: { "content-type": "application/zip" },
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
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
  return await runSkillCommand(parsed.output, httpsTransport);
};
