import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  FirmKnowledgeJobStore,
  isReusableFirmKnowledgeJob,
} from "./firm-knowledge-job-store";

const ORGANIZATION_1 = toSafeId<"organization">("organization-1");
const ORGANIZATION_2 = toSafeId<"organization">("organization-2");
const USER_1 = toSafeId<"user">("user-1");
const USER_2 = toSafeId<"user">("user-2");
const PARAMETERS = {
  matters: 10,
  replaceIncomplete: true,
  selectionSeed: "quick-start-seed",
} as const;

describe("FirmKnowledgeJobStore", () => {
  test("retains an owned terminal job while a later job runs", () => {
    let now = 0;
    const ids = ["job-1", "job-2"];
    const store = new FirmKnowledgeJobStore({
      createId: () => ids.shift() ?? "unexpected-job",
      maxRetainedJobs: 2,
      now: () => now,
      retentionMs: 1000,
    });
    const first = store.create({
      organizationId: ORGANIZATION_1,
      parameters: PARAMETERS,
      startedAt: "2026-08-16T10:00:00.000Z",
      userId: USER_1,
    });
    store.update(first.id, {
      status: "succeeded",
      startedAt: "2026-08-16T10:00:00.000Z",
      finishedAt: "2026-08-16T10:01:00.000Z",
    });

    now = 500;
    store.create({
      organizationId: ORGANIZATION_2,
      parameters: PARAMETERS,
      startedAt: "2026-08-16T10:02:00.000Z",
      userId: USER_1,
    });

    expect(store.getOwned(first.id, USER_1)?.status.status).toBe("succeeded");
    expect(store.getOwned(first.id, USER_2)).toBeNull();
  });

  test("expires terminal jobs before admitting a later job", () => {
    let now = 0;
    const ids = ["job-1", "job-2"];
    const store = new FirmKnowledgeJobStore({
      createId: () => ids.shift() ?? "unexpected-job",
      maxRetainedJobs: 1,
      now: () => now,
      retentionMs: 1000,
    });
    const first = store.create({
      organizationId: ORGANIZATION_1,
      parameters: PARAMETERS,
      startedAt: "2026-08-16T10:00:00.000Z",
      userId: USER_1,
    });
    store.update(first.id, {
      status: "failed",
      startedAt: "2026-08-16T10:00:00.000Z",
      finishedAt: "2026-08-16T10:01:00.000Z",
      message: "failed",
    });

    now = 1001;
    store.create({
      organizationId: ORGANIZATION_2,
      parameters: PARAMETERS,
      startedAt: "2026-08-16T10:02:00.000Z",
      userId: USER_1,
    });

    expect(store.get(first.id)).toBeNull();
  });

  test("reuses an active job only for the same owner and exact seed parameters", () => {
    const store = new FirmKnowledgeJobStore({ createId: () => "job-1" });
    const job = store.create({
      organizationId: ORGANIZATION_1,
      parameters: PARAMETERS,
      startedAt: "2026-08-16T10:00:00.000Z",
      userId: USER_1,
    });

    expect(
      isReusableFirmKnowledgeJob(job, {
        organizationId: ORGANIZATION_1,
        parameters: PARAMETERS,
        userId: USER_1,
      }),
    ).toBeTrue();

    const conflictingRequests = [
      {
        organizationId: ORGANIZATION_2,
        parameters: PARAMETERS,
        userId: USER_1,
      },
      {
        organizationId: ORGANIZATION_1,
        parameters: PARAMETERS,
        userId: USER_2,
      },
      {
        organizationId: ORGANIZATION_1,
        parameters: { ...PARAMETERS, matters: 15 },
        userId: USER_1,
      },
      {
        organizationId: ORGANIZATION_1,
        parameters: { ...PARAMETERS, replaceIncomplete: false },
        userId: USER_1,
      },
      {
        organizationId: ORGANIZATION_1,
        parameters: { ...PARAMETERS, selectionSeed: "another-seed" },
        userId: USER_1,
      },
    ];

    for (const request of conflictingRequests) {
      expect(isReusableFirmKnowledgeJob(job, request)).toBeFalse();
    }

    store.update(job.id, {
      status: "succeeded",
      startedAt: "2026-08-16T10:00:00.000Z",
      finishedAt: "2026-08-16T10:01:00.000Z",
    });
    expect(store.get(job.id)?.parameters).toEqual(PARAMETERS);
    expect(
      isReusableFirmKnowledgeJob(store.get(job.id) ?? job, {
        organizationId: ORGANIZATION_1,
        parameters: PARAMETERS,
        userId: USER_1,
      }),
    ).toBeFalse();
  });
});
