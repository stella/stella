import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";
import { rejectionOf } from "@stll/property-testing/rejection";

import { toSafeId } from "@/api/lib/branded-types";
import {
  UploadedMailUnavailableError,
  type fileUploadedMail,
} from "@/api/lib/email/inbound/upload";
import { enqueueUploadedMailFiling } from "@/api/lib/email/inbound/upload-enqueue";
import {
  processUploadedMailJob,
  reportUploadedMailJobFailure,
} from "@/api/lib/email/inbound/upload-queue";
import type { observeFailure } from "@/api/lib/observability/observe-failure";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const scope = {
  organizationId: toSafeId<"organization">("org_1"),
  workspaceId: toSafeId<"workspace">("workspace_1"),
  entityId: toSafeId<"entity">("entity_1"),
};
const file = {
  sourceFileId: "file_1",
  storageMimeType: EML_MIME_TYPE,
  mimeType: EML_MIME_TYPE,
};
const database = asTestRaw<Parameters<typeof fileUploadedMail>[0]["database"]>(
  {},
);
const bytes = new TextEncoder().encode(
  "From: a@example.com\r\n\r\nBody",
).buffer;

const unavailable = () =>
  Result.err(
    new UploadedMailUnavailableError({ message: "database unavailable" }),
  );
const FILED = {
  status: "filed",
  correspondenceId: toSafeId<"correspondence">("record_1"),
} as const;
const filed = () => Result.ok(FILED);

type QueuedJob = { name: string; data: unknown; jobId: string };

const fakeQueue = () => {
  const jobs = new Map<string, QueuedJob>();
  return {
    jobs,
    queue: {
      add: async (
        name: string,
        data: Parameters<typeof processUploadedMailJob>[0]["data"],
        options: { jobId: string },
      ) => {
        jobs.set(options.jobId, { name, data, jobId: options.jobId });
      },
      getJob: async (jobId: string) =>
        jobs.has(jobId)
          ? {
              getState: async () => "waiting" as const,
              remove: async () => {},
              retry: async () => {},
            }
          : undefined,
    },
  };
};

describe("uploaded mail hand-off from the extraction run", () => {
  test("a replayed extraction run collapses onto one job per file", async () => {
    const { jobs, queue } = fakeQueue();
    for (let run = 0; run < 2; run += 1) {
      await enqueueUploadedMailFiling({ file, scope, queue });
    }
    expect([...jobs.values()]).toEqual([
      expect.objectContaining({
        name: "file-uploaded-mail",
        data: { ...scope, ...file },
      }),
    ]);
  });
});

describe("uploaded mail filing job", () => {
  const data = { ...scope, ...file };
  const readFile = async () =>
    testScannedFile({ bytes, mimeType: EML_MIME_TYPE });

  test("an attempt that cannot reach the database rejects so BullMQ retries", async () => {
    expect(
      await rejectionOf(
        processUploadedMailJob({
          data,
          database,
          readFile,
          fileMail: async () => unavailable(),
        }),
      ),
    ).toBeInstanceOf(UploadedMailUnavailableError);
  });

  test("a permanent refusal is a terminal skip", async () => {
    expect(
      await processUploadedMailJob({
        data,
        database,
        readFile,
        fileMail: async () =>
          Result.ok({ status: "skipped", reason: "no_matter_access" }),
      }),
    ).toEqual({ status: "skipped", reason: "no_matter_access" });
  });

  test("an attempt files the stored file under the job's scope", async () => {
    const fileMail = mock<typeof fileUploadedMail>(async () => filed());
    expect(
      await processUploadedMailJob({ data, database, readFile, fileMail }),
    ).toEqual(FILED);
    expect(fileMail.mock.calls.at(0)?.[0]).toMatchObject({
      mimeType: EML_MIME_TYPE,
      scope,
    });
  });

  test("every failed attempt is observed and only an exhausted job escalates", () => {
    const observe = mock<typeof observeFailure>(() => {});
    const error = new Error("still unavailable");
    const job = (attemptsMade: number) => ({
      attemptsMade,
      opts: { attempts: 6 },
      data: { entityId: scope.entityId },
    });
    expect(reportUploadedMailJobFailure({ job: job(1), error, observe })).toBe(
      "retrying",
    );
    expect(reportUploadedMailJobFailure({ job: job(5), error, observe })).toBe(
      "retrying",
    );
    expect(reportUploadedMailJobFailure({ job: job(6), error, observe })).toBe(
      "exhausted",
    );
    expect(observe.mock.calls.map(([, { escalation }]) => escalation)).toEqual([
      undefined,
      undefined,
      "sustained",
    ]);
  });
});
