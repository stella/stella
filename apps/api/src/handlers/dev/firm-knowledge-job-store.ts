import { panic } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";

export type FirmKnowledgeSeedStatus =
  | { status: "idle" }
  | { status: "running"; startedAt: string }
  | { status: "succeeded"; startedAt: string; finishedAt: string }
  | {
      status: "failed";
      startedAt: string;
      finishedAt: string;
      message: string;
    };

export type FirmKnowledgeJob = {
  id: string;
  organizationId: SafeId<"organization">;
  status: FirmKnowledgeSeedStatus;
  userId: SafeId<"user">;
};

type StoredFirmKnowledgeJob = FirmKnowledgeJob & {
  updatedAtMs: number;
};

type CreateFirmKnowledgeJobOptions = {
  organizationId: SafeId<"organization">;
  startedAt: string;
  userId: SafeId<"user">;
};

type FirmKnowledgeJobStoreOptions = {
  createId: () => string;
  maxRetainedJobs: number;
  now: () => number;
  retentionMs: number;
};

const DEFAULT_MAX_RETAINED_JOBS = 20;
const DEFAULT_RETENTION_MS = 60 * 60 * 1000;

const defaultOptions = {
  createId: () => Bun.randomUUIDv7(),
  maxRetainedJobs: DEFAULT_MAX_RETAINED_JOBS,
  now: () => Date.now(),
  retentionMs: DEFAULT_RETENTION_MS,
} satisfies FirmKnowledgeJobStoreOptions;

export class FirmKnowledgeJobStore {
  private readonly createId: () => string;
  private readonly jobs = new Map<string, StoredFirmKnowledgeJob>();
  private readonly maxRetainedJobs: number;
  private readonly now: () => number;
  private readonly retentionMs: number;

  constructor(options: Partial<FirmKnowledgeJobStoreOptions> = {}) {
    this.createId = options.createId ?? defaultOptions.createId;
    this.maxRetainedJobs =
      options.maxRetainedJobs ?? defaultOptions.maxRetainedJobs;
    this.now = options.now ?? defaultOptions.now;
    this.retentionMs = options.retentionMs ?? defaultOptions.retentionMs;
  }

  create({
    organizationId,
    startedAt,
    userId,
  }: CreateFirmKnowledgeJobOptions): FirmKnowledgeJob {
    this.prune();
    const now = this.now();
    const job = {
      id: this.createId(),
      organizationId,
      status: { status: "running", startedAt },
      updatedAtMs: now,
      userId,
    } satisfies StoredFirmKnowledgeJob;
    this.jobs.set(job.id, job);
    return job;
  }

  get(jobId: string): FirmKnowledgeJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  getOwned(jobId: string, userId: SafeId<"user">): FirmKnowledgeJob | null {
    const job = this.jobs.get(jobId);
    return job?.userId === userId ? job : null;
  }

  update(jobId: string, status: FirmKnowledgeSeedStatus): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      panic(`Missing firm-knowledge seed job ${jobId}.`);
    }
    this.jobs.set(jobId, {
      id: job.id,
      organizationId: job.organizationId,
      status,
      updatedAtMs: this.now(),
      userId: job.userId,
    });
  }

  private prune(): void {
    const expiryCutoff = this.now() - this.retentionMs;
    for (const [jobId, job] of this.jobs) {
      if (job.status.status !== "running" && job.updatedAtMs <= expiryCutoff) {
        this.jobs.delete(jobId);
      }
    }

    for (const [jobId, job] of this.jobs) {
      if (this.jobs.size < this.maxRetainedJobs) {
        return;
      }
      if (job.status.status !== "running") {
        this.jobs.delete(jobId);
      }
    }

    if (this.jobs.size >= this.maxRetainedJobs) {
      panic("Firm-knowledge seed job retention is full.");
    }
  }
}
