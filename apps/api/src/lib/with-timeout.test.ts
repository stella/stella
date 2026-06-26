import { describe, expect, test } from "bun:test";

import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { withTimeout } from "@/api/lib/with-timeout";

describe("withTimeout", () => {
  test("returns the operation result when it settles before the deadline", async () => {
    const result = await withTimeout(
      async () => {
        await Bun.sleep(5);
        return "ok";
      },
      { label: "fast", timeoutMs: 1000 },
    );

    expect(result).toBe("ok");
  });

  test("rejects with a TimeoutError when the operation outlives the deadline", async () => {
    let captured: unknown;
    try {
      await withTimeout(
        async () => {
          await Bun.sleep(1000);
          return "never";
        },
        { label: "wedged-read", timeoutMs: 10 },
      );
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(TimeoutError);
    expect(captured).toMatchObject({ label: "wedged-read", timeoutMs: 10 });
  });

  test("a late operation rejection after the timeout does not surface as unhandled", async () => {
    let rejectedLate = false;
    const onUnhandled = () => {
      rejectedLate = true;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      let captured: unknown;
      try {
        await withTimeout(
          async () => {
            // Settles (rejecting) well after the deadline has already won.
            await Bun.sleep(20);
            throw new TimeoutError({
              message: "late connection failure",
              label: "late-op",
            });
          },
          { label: "late-wrapper", timeoutMs: 5 },
        );
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(TimeoutError);
      expect(captured).toMatchObject({ label: "late-wrapper" });

      await Bun.sleep(40);
      expect(rejectedLate).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
