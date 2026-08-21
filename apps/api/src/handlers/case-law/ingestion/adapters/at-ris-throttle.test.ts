import { describe, expect, it } from "bun:test";

import { createAtRisRequestSlot } from "@/api/handlers/case-law/ingestion/adapters/at-ris-throttle";

describe("Austrian RIS publisher gate", () => {
  it("does not validate Redis configuration until a deployed request", () => {
    const environment = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== "REDIS_URL"),
      ),
      NODE_ENV: "production",
    };
    const moduleUrl = new URL("publisher-request-gate.ts", import.meta.url)
      .href;
    const imported = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `await import(${JSON.stringify(moduleUrl)})`,
      ],
      env: environment,
    });

    expect(imported.exitCode).toBe(0);
    expect(imported.stderr.toString()).toBe("");
  });

  it("reserves every concurrent request against the shared Redis key", async () => {
    const waits = [0, 5000, 10_000];
    const commands: string[][] = [];
    const sleeps: number[] = [];
    const reserve = createAtRisRequestSlot({
      redis: () => ({
        send: async (_command, args) => {
          commands.push(args);
          return waits.at(commands.length - 1);
        },
      }),
      sleep: async (durationMs) => {
        sleeps.push(durationMs);
      },
    });

    await Promise.all([reserve(), reserve(), reserve()]);

    expect(sleeps).toEqual(waits);
    expect(commands).toHaveLength(3);
    for (const args of commands) {
      expect(args.slice(1)).toEqual([
        "1",
        "case-law:publisher-gate:ris-bka",
        "5000",
      ]);
    }
  });

  it("fails closed when Redis returns an invalid reservation", async () => {
    const reserve = createAtRisRequestSlot({
      redis: () => ({ send: async () => "not-a-number" }),
      sleep: async () => {
        throw new Error("invalid reservations must not reach sleep");
      },
    });

    await expect(reserve()).rejects.toThrow("invalid wait");
  });

  it("abandons a Redis reservation when the ingestion signal aborts", async () => {
    const controller = new AbortController();
    const reserve = createAtRisRequestSlot({
      redis: () => ({ send: async () => await new Promise(() => {}) }),
      sleep: async () => {
        throw new Error("an unreserved request must not sleep");
      },
    });

    const pending = reserve(controller.signal);
    controller.abort(new DOMException("Stopped", "AbortError"));

    await expect(pending).rejects.toThrow("Stopped");
  });
});
