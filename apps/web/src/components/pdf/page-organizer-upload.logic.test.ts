import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";

import {
  commitCompletedUpload,
  createPageOrganizerUploadOwner,
} from "./page-organizer-upload.logic";

const receipt = (suffix: string) => ({
  entityVersionId: toSafeId<"entityVersion">(`version-${suffix}`),
  fileId: `file-${suffix}`,
});

describe("page organizer upload ownership", () => {
  test("cancelled upload resolving late preserves the pre-upload view for save and sign", () => {
    const owner = createPageOrganizerUploadOwner();
    const pending = owner.begin();
    const commits: string[] = [];
    let visibleVersion = "original";

    owner.cancel(pending);
    const late = owner.complete(pending, receipt("withdrawn"));
    if (late.type === "completed") {
      commitCompletedUpload(late, (upload) => {
        commits.push(`save:${upload.fileId}`, `sign:${upload.fileId}`);
        visibleVersion = upload.fileId;
      });
    }

    expect(late).toEqual({ type: "cancelled", uploadId: pending.uploadId });
    expect(commits).toEqual([]);
    expect(visibleVersion).toBe("original");
  });

  test("a new upload after cancellation is saved and signed", () => {
    const owner = createPageOrganizerUploadOwner();
    const cancelled = owner.begin();
    owner.cancel(cancelled);
    const next = owner.begin();
    const outcome = owner.complete(next, receipt("next"));
    const commits: string[] = [];

    if (outcome.type === "completed") {
      commitCompletedUpload(outcome, (upload) => {
        commits.push(`save:${upload.fileId}`, `sign:${upload.fileId}`);
      });
    }

    expect(commits).toEqual(["save:file-next", "sign:file-next"]);
  });

  test("only the newest upload can be committed when the first resolves last", () => {
    const owner = createPageOrganizerUploadOwner();
    const first = owner.begin();
    const second = owner.begin();
    const secondOutcome = owner.complete(second, receipt("second"));
    const firstOutcome = owner.complete(first, receipt("first"));
    const commits: string[] = [];

    for (const outcome of [secondOutcome, firstOutcome]) {
      if (outcome.type === "completed") {
        commitCompletedUpload(outcome, (upload) => commits.push(upload.fileId));
      }
    }

    expect(firstOutcome).toEqual({
      type: "superseded",
      uploadId: first.uploadId,
    });
    expect(commits).toEqual(["file-second"]);
  });
});
