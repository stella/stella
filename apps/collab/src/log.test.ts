import { expect, spyOn, test } from "bun:test";

import { logCollabEvent } from "./log";

for (const status of ["refused", "unknown"] as const) {
  test(`store policy ${status} logs its value and diagnostic event`, () => {
    const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
    const event = {
      event: "redis_store_policy",
      level: "error",
      status,
      storeClass: "durable-coordination",
      operatorAction: "configure-store-policy",
    } as const;
    try {
      logCollabEvent(event);
      expect(stdout.mock.calls).toEqual([
        [
          `${JSON.stringify({ AdmissionStoreEvictionPolicyRefused: status === "refused" ? 1 : 0 })}\n`,
        ],
      ]);
      expect(stderr.mock.calls).toEqual([
        [`${JSON.stringify({ service: "collab", ...event })}\n`],
      ]);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
}
