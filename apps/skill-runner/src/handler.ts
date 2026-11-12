import { Result } from "better-result";
import * as v from "valibot";

import { skillRunnerInputSchema } from "@stll/api-contract/skill-runner";
import { fetchWithTimeout } from "@stll/fetch";
import { readBodyWithIdleDeadline } from "@stll/fetch/body-reader";

import { SkillRunnerArchiveError } from "./archive";
import { checkCredentialIsolation } from "./isolation";
import { type ArchiveTransport, runSkillCommand } from "./run";

/** The execution environment's process table; the runner is Linux only. */
const PROC_ROOT = "/proc";

/** False when the process is already gone. */
const killProcess = (pid: number): boolean =>
  Result.try(() => process.kill(pid, "SIGKILL")).isOk();

/**
 * One archive download, headers and body: the 200 MB cap from S3 in the same
 * region, with room to spare. With the upload and the command's own limit it
 * fits a Lambda's 15 minutes (`SKILL_RUNNER_LIMITS.commandTimeoutMs`).
 */
const DOWNLOAD_TIMEOUT_MS = 45_000;
/** The body may not stall longer than this between chunks. */
const BODY_IDLE_MS = 30_000;
/** A workspace upload of up to the archive cap, to S3 in the same region. */
const UPLOAD_TIMEOUT_MS = 90_000;

/** Presigned S3 URLs over HTTPS; a body larger than allowed is refused. */
const httpsTransport: ArchiveTransport = {
  get: async (url, maxBytes) => {
    const response = await fetchWithTimeout(url, {
      redirect: "error",
      timeout: { type: "total", ms: DOWNLOAD_TIMEOUT_MS },
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
  const isolated = await checkCredentialIsolation(PROC_ROOT);
  if (isolated.isErr()) {
    throw isolated.error;
  }
  const ran = await runSkillCommand(parsed.output, httpsTransport, {
    sweep: { procRoot: PROC_ROOT, kill: killProcess },
  });
  if (ran.isErr()) {
    throw ran.error;
  }
  return ran.value;
};
