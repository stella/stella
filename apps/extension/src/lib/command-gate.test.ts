import { describe, expect, test } from "bun:test";

import { createCommandGate } from "./command-gate";

describe("browser command gate", () => {
  test("rejects overlap and releases the controller after completion", async () => {
    const gate = createCommandGate();
    let release = (): void => undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = gate.run(async () => {
      await blocker;
      return "first";
    });

    expect(await gate.run(async () => "hidden late action")).toEqual({
      status: "busy",
    });
    release();
    expect(await first).toEqual({ result: "first", status: "completed" });
    expect(await gate.run(async () => "next")).toEqual({
      result: "next",
      status: "completed",
    });
  });
});
