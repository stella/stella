import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";
import { rejectionOf } from "@stll/property-testing/rejection";

import { toSafeId } from "@/api/lib/branded-types";
import {
  UploadedMailUnavailableError,
  type fileUploadedMail,
} from "@/api/lib/email/inbound/upload";
import {
  fileUploadedMailOrRetry,
  processUploadedMailJob,
  reportUploadedMailJobFailure,
} from "@/api/lib/uploaded-mail-correspondence-queue";
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
const filed = () =>
  Result.ok({
    status: "filed" as const,
    correspondenceId: toSafeId<"correspondence">("record_1"),
  });

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

describe("uploaded mail filing from the extraction run", () => {
  test("an unavailable database hands the file to one retry job per file", async () => {
    const { jobs, queue } = fakeQueue();
    const fileMail = mock<typeof fileUploadedMail>(async () => unavailable());
    for (let run = 0; run < 2; run += 1) {
      const outcome = await fileUploadedMailOrRetry({
        bytes,
        file,
        scope,
        database,
        fileMail,
        queue,
      });
      expect(outcome.isOk() && outcome.value).toEqual({
        status: "retry_scheduled",
      });
    }
    expect([...jobs.values()]).toEqual([
      expect.objectContaining({
        name: "file-uploaded-mail",
        data: { ...scope, ...file },
      }),
    ]);
  });

  test("a permanent refusal is a terminal skip that schedules nothing", async () => {
    const { jobs, queue } = fakeQueue();
    const outcome = await fileUploadedMailOrRetry({
      bytes,
      file,
      scope,
      database,
      fileMail: async () =>
        Result.ok({ status: "skipped", reason: "no_matter_access" }),
      queue,
    });
    expect(outcome.isOk() && outcome.value).toEqual({
      status: "skipped",
      reason: "no_matter_access",
    });
    expect(jobs.size).toBe(0);
  });

  test("a failed hand-off is returned for telemetry, never thrown", async () => {
    const outcome = await fileUploadedMailOrRetry({
      bytes,
      file,
      scope,
      database,
      fileMail: async () => unavailable(),
      queue: {
        add: async () => {
          throw new Error("queue unavailable");
        },
        getJob: async () => undefined,
      },
    });
    expect(outcome.isErr()).toBe(true);
  });
});

describe("uploaded mail retry job", () => {
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

  test("an attempt files the stored file under the job's scope", async () => {
    const fileMail = mock<typeof fileUploadedMail>(async () => filed());
    expect(
      await processUploadedMailJob({ data, database, readFile, fileMail }),
    ).toEqual({ status: "filed", correspondenceId: "record_1" });
    expect(fileMail.mock.calls.at(0)?.[0]).toMatchObject({
      mimeType: EML_MIME_TYPE,
      scope,
    });
  });

  test("only an exhausted job reaches telemetry", () => {
    const capture = mock(() => {});
    const error = new Error("still unavailable");
    const job = (attemptsMade: number) => ({
      attemptsMade,
      opts: { attempts: 6 },
      data: { entityId: scope.entityId },
    });
    expect(reportUploadedMailJobFailure({ job: job(1), error, capture })).toBe(
      "retrying",
    );
    expect(reportUploadedMailJobFailure({ job: job(5), error, capture })).toBe(
      "retrying",
    );
    expect(capture).not.toHaveBeenCalled();
    expect(reportUploadedMailJobFailure({ job: job(6), error, capture })).toBe(
      "exhausted",
    );
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
