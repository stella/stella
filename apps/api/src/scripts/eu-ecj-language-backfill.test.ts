import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { underSourceLease } from "./eu-ecj-language-backfill";

const releaseCounter = () => {
  const lease = { released: 0 };
  return {
    lease,
    sourceLease: {
      release: async () => {
        lease.released += 1;
      },
    },
  };
};

describe("the source lease of a language backfill", () => {
  // Each storage refresh runs after the lease is taken; a refresh that fails
  // must not leave the source's ingestion blocked until the lease expires.
  test.each(["first refresh", "second refresh", "work"] as const)(
    "is released once when the %s rejects",
    async (failing) => {
      const { lease, sourceLease } = releaseCounter();
      const failure = new Error(`${failing} failed`);
      const ran: string[] = [];
      const step = async (name: typeof failing) => {
        ran.push(name);
        if (name === failing) {
          throw failure;
        }
      };

      expect(
        await rejectionOf(
          underSourceLease({
            sourceLease,
            prepare: async () => {
              await step("first refresh");
              await step("second refresh");
            },
            work: async () => {
              await step("work");
              return 0;
            },
          }),
        ),
      ).toBe(failure);
      expect(lease.released).toBe(1);
      expect(ran.at(-1)).toBe(failing);
    },
  );

  test("is released once after the work returns its exit code", async () => {
    const { lease, sourceLease } = releaseCounter();
    expect(
      await underSourceLease({
        sourceLease,
        prepare: async () => undefined,
        work: async () => 1,
      }),
    ).toBe(1);
    expect(lease.released).toBe(1);
  });

  test("a plan run without a lease prepares and works", async () => {
    expect(
      await underSourceLease({
        sourceLease: null,
        prepare: async () => undefined,
        work: async () => 0,
      }),
    ).toBe(0);
  });
});
