import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-hand-built-document-run-queue";
const lint = async (
  source: string,
  sourcePath = "apps/api/src/lib/contracts/run-queue.ts",
) => await lintSingleRule(RULE, source, { sourcePath, cwd: "scratch" });

const RUN_TABLE = 'import { documentReviewRuns } from "@/api/db/schema";';

describe.serial(RULE, () => {
  test("rejects every hand-built construction beside a document run table", async () => {
    expect(
      await lint(
        [
          RUN_TABLE,
          'import { BullMqWorker, createLazyBullMqQueue as lazy } from "@/api/lib/bullmq-queue";',
          'import * as queues from "../bullmq-queue.ts";',
          'import { Queue } from "bullmq";',
        ].join("\n"),
      ),
    ).toEqual([2, 2, 3, 4]);
  });

  test("reads the table through a schema slice as well", async () => {
    expect(
      await lint(
        [
          'import { legalListVerificationRuns } from "@/api/db/schema/lists-verification";',
          'import { BullMqWorker } from "@/api/lib/bullmq-queue";',
        ].join("\n"),
      ),
    ).toEqual([2]);
  });

  test("reads the table through a namespace import of the schema", async () => {
    expect(
      await lint(
        [
          'import * as schema from "@/api/db/schema";',
          'import { Queue } from "bullmq";',
          "export const runs = schema.documentReviewRuns;",
        ].join("\n"),
      ),
    ).toEqual([2]);
    expect(
      await lint(
        [
          'import * as schema from "@/api/db/schema";',
          'import { Queue } from "bullmq";',
          "export const flows = schema.flowRuns;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("accepts the owner's factory beside a document run table", async () => {
    expect(
      await lint(
        [
          RUN_TABLE,
          'import { createDocumentRunQueue } from "@/api/lib/queue/document-run-queue";',
          'import type { BullMqWorkerContext } from "@/api/lib/bullmq-queue";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("leaves queues over other tables alone", async () => {
    expect(
      await lint(
        [
          'import { flowRuns } from "@/api/db/schema";',
          'import type { documentReviewRuns } from "@/api/db/schema";',
          'import { BullMqWorker, createLazyBullMqQueue } from "@/api/lib/bullmq-queue";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("admits the owner and the listed backlog only", async () => {
    const handBuilt = [
      RUN_TABLE,
      'import { BullMqWorker } from "@/api/lib/bullmq-queue";',
    ].join("\n");
    expect(
      await lint(handBuilt, "apps/api/src/lib/queue/document-run-queue.ts"),
    ).toEqual([]);
    expect(
      await lint(handBuilt, "apps/api/src/lib/bilingual/run-queue.ts"),
    ).toEqual([]);
    expect(
      await lint(handBuilt, "apps/api/src/lib/document-review/run-queue.ts"),
    ).toEqual([2]);
  });
});
