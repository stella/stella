// Passive regression fixture for
// no-hand-built-document-run-queue/no-hand-built-document-run-queue.
//
// The module reads a document run table, so every import that would build a
// BullMQ queue or worker by hand carries a disable. If detection regresses,
// that directive becomes unused and fixture lint fails.

// oxlint-disable-next-line no-hand-built-document-run-queue/no-hand-built-document-run-queue -- fixture: a raw BullMQ queue beside a document run table
import { Queue } from "bullmq";

// expect-clean: no-hand-built-document-run-queue/no-hand-built-document-run-queue
import { documentReviewRuns } from "@/api/db/schema";
// oxlint-disable-next-line no-hand-built-document-run-queue/no-hand-built-document-run-queue -- x2: the worker and the lazy queue constructors
import { BullMqWorker, createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
// expect-clean: no-hand-built-document-run-queue/no-hand-built-document-run-queue
import { createDocumentRunQueue } from "@/api/lib/queue/document-run-queue";

export const handles = [
  Queue,
  documentReviewRuns,
  BullMqWorker,
  createLazyBullMqQueue,
  createDocumentRunQueue,
];
