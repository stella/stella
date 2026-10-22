import type { Job } from "bullmq";
import { expect, test } from "bun:test";

import { BULLMQ_QUEUE_HOSTS, BullMqWorker } from "@/api/lib/bullmq-queue";
import {
  currentQueryCount,
  queryCountLogger,
} from "@/api/lib/db-query-counter";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

class ProcessorProbe extends BullMqWorker<unknown, number> {
  static async invoke(name: string, processor: () => Promise<number>) {
    // Exercise BullMQ's processor boundary without opening a queue connection.
    const worker = asTestRaw<ProcessorProbe>({ name, processFn: processor });
    return ProcessorProbe.prototype.callProcessJob.call(
      worker,
      asTestRaw<Job<unknown, number>>({}),
      "probe",
    );
  }
}

test("every hosted queue counts each processor invocation independently", async () => {
  for (const name of Object.keys(BULLMQ_QUEUE_HOSTS)) {
    const processor = async () => {
      expect(currentQueryCount()).toBe(0);
      queryCountLogger.logQuery("select 1", []);
      await Promise.resolve();
      queryCountLogger.logQuery("select 2", []);
      expect(currentQueryCount()).toBe(2);
      return 2;
    };
    expect(await ProcessorProbe.invoke(name, processor)).toBe(2);
    expect(await ProcessorProbe.invoke(name, processor)).toBe(2);
    expect(currentQueryCount()).toBeUndefined();
  }
});
