import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";

import {
  commitCompletedUpload,
  createPageOrganizerOperationOwner,
  createPageOrganizerUploadOwner,
} from "./page-organizer-upload.logic";

const receipt = (suffix: string) => ({
  entityVersionId: toSafeId<"entityVersion">(`version-${suffix}`),
  fileId: `file-${suffix}`,
});

describe("page organizer upload ownership", () => {
  test("cancelled upload resolving late preserves the pre-upload view for save and sign", () => {
    const operationOwner = createPageOrganizerOperationOwner();
    const owner = createPageOrganizerUploadOwner();
    const pending = owner.begin();
    const commits: string[] = [];
    let visibleVersion = "original";

    owner.cancel(pending);
    const late = owner.prepareCompletion(pending, receipt("withdrawn"));
    if (late.type === "completed") {
      commitCompletedUpload(
        operationOwner.operation,
        operationOwner,
        late,
        (upload) => {
          commits.push(`save:${upload.fileId}`, `sign:${upload.fileId}`);
          visibleVersion = upload.fileId;
        },
      );
    }

    expect(late).toEqual({ type: "cancelled", uploadId: pending.uploadId });
    expect(commits).toEqual([]);
    expect(visibleVersion).toBe("original");
  });

  test("a new upload after cancellation is saved and signed", () => {
    const operationOwner = createPageOrganizerOperationOwner();
    const owner = createPageOrganizerUploadOwner();
    const cancelled = owner.begin();
    owner.cancel(cancelled);
    const next = owner.begin();
    const provisional = owner.prepareCompletion(next, receipt("next"));
    const outcome =
      provisional.type === "provisional"
        ? owner.commit(provisional)
        : provisional;
    const commits: string[] = [];

    if (outcome.type === "completed") {
      commitCompletedUpload(
        operationOwner.operation,
        operationOwner,
        outcome,
        (upload) => {
          commits.push(`save:${upload.fileId}`, `sign:${upload.fileId}`);
        },
      );
    }

    expect(commits).toEqual(["save:file-next", "sign:file-next"]);
  });

  test("only the newest upload can be committed when the first resolves last", () => {
    const operationOwner = createPageOrganizerOperationOwner();
    const owner = createPageOrganizerUploadOwner();
    const first = owner.begin();
    const second = owner.begin();
    const secondProvisional = owner.prepareCompletion(
      second,
      receipt("second"),
    );
    const secondOutcome =
      secondProvisional.type === "provisional"
        ? owner.commit(secondProvisional)
        : secondProvisional;
    const firstOutcome = owner.prepareCompletion(first, receipt("first"));
    const commits: string[] = [];

    for (const outcome of [secondOutcome, firstOutcome]) {
      if (outcome.type === "completed") {
        commitCompletedUpload(
          operationOwner.operation,
          operationOwner,
          outcome,
          (upload) => commits.push(upload.fileId),
        );
      }
    }

    expect(firstOutcome).toEqual({
      type: "superseded",
      uploadId: first.uploadId,
    });
    expect(commits).toEqual(["file-second"]);
  });

  test("unmount during query invalidation prevents saving or reading the signing target", async () => {
    const operationOwner = createPageOrganizerOperationOwner();
    const owner = createPageOrganizerUploadOwner();
    const pending = owner.begin();
    const provisional = owner.prepareCompletion(pending, receipt("dismissed"));
    if (provisional.type !== "provisional") {
      throw new Error("Expected the upload to be provisional");
    }
    let releaseInvalidation = () => {};
    const invalidation = new Promise<void>((resolve) => {
      releaseInvalidation = resolve;
    });
    const savedVersions: string[] = [];
    const signingTargetReads: string[] = [];
    const finish = async () => {
      await invalidation;
      const outcome = owner.commit(provisional);
      if (outcome.type === "completed") {
        commitCompletedUpload(
          operationOwner.operation,
          operationOwner,
          outcome,
          (upload) => {
            savedVersions.push(upload.fileId);
            signingTargetReads.push(upload.fileId);
          },
        );
      }
      return outcome;
    };

    const result = finish();
    owner.cancelCurrent();
    releaseInvalidation();

    expect(await result).toEqual({
      type: "cancelled",
      uploadId: pending.uploadId,
    });
    expect(savedVersions).toEqual([]);
    expect(signingTargetReads).toEqual([]);
  });

  test("revoked operations cannot commit a completed receipt", () => {
    const operationOwner = createPageOrganizerOperationOwner();
    const uploadOwner = createPageOrganizerUploadOwner();
    const pending = uploadOwner.begin();
    const provisional = uploadOwner.prepareCompletion(pending, receipt("late"));
    if (provisional.type !== "provisional") {
      throw new Error("Expected the upload to be provisional");
    }
    const completed = uploadOwner.commit(provisional);
    if (completed.type !== "completed") {
      throw new Error("Expected the upload to complete");
    }
    const commits: string[] = [];

    operationOwner.revoke();
    const result = commitCompletedUpload(
      operationOwner.operation,
      operationOwner,
      completed,
      (upload) => commits.push(upload.fileId),
    );

    expect(result).toBeNull();
    expect(commits).toEqual([]);
  });

  test("only the newest transform request remains current", () => {
    const owner = createPageOrganizerOperationOwner();
    const first = owner.beginRequest(owner.operation);
    const second = owner.beginRequest(owner.operation);

    expect(owner.isCurrent(first)).toBe(false);
    expect(owner.isCurrent(second)).toBe(true);
  });
});

test("a newer request aborts every controller owned by the superseded request", () => {
  const owner = createPageOrganizerOperationOwner();
  const first = owner.beginRequest(owner.operation);
  const transform = new AbortController();
  const upload = new AbortController();
  owner.ownController(first, transform);
  owner.ownController(first, upload);

  owner.beginRequest(owner.operation);

  expect(transform.signal.aborted).toBe(true);
  expect(upload.signal.aborted).toBe(true);
});

test("a receipt is single-use and bound to its request and upload owner", () => {
  const operationOwner = createPageOrganizerOperationOwner();
  const uploadOwner = createPageOrganizerUploadOwner();
  const otherUploadOwner = createPageOrganizerUploadOwner();
  const request = operationOwner.beginRequest(operationOwner.operation);
  const pending = uploadOwner.begin(request);
  const provisional = uploadOwner.prepareCompletion(pending, receipt("bound"));
  if (provisional.type !== "provisional") {
    throw new Error("Expected provisional upload");
  }
  const completed = uploadOwner.commit(provisional);
  if (completed.type !== "completed") {
    throw new Error("Expected completed upload");
  }
  const commits: string[] = [];

  expect(
    otherUploadOwner.consume(request, operationOwner, completed, ({ fileId }) =>
      commits.push(fileId),
    ),
  ).toBeNull();
  expect(
    uploadOwner.consume(request, operationOwner, completed, ({ fileId }) =>
      commits.push(fileId),
    ),
  ).toBe(1);
  expect(
    uploadOwner.consume(request, operationOwner, completed, ({ fileId }) =>
      commits.push(fileId),
    ),
  ).toBeNull();
  expect(commits).toEqual(["file-bound"]);
});
