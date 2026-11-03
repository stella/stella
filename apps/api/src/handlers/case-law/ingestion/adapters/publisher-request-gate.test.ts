import { expect, test } from "bun:test";

import { LIMITER_STORE_UNAVAILABLE } from "@stll/api-contract/action-admission";
import { TimeoutError } from "@stll/concurrency/with-timeout";
import { rejectionOf } from "@stll/property-testing/rejection";

import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import { LimiterStoreUnavailableError } from "@/api/lib/rate-limit/store-unavailable";

import {
  createPublisherRequestSlot,
  PublisherPacingStopped,
} from "./publisher-request-gate";

const CONFIG = {
  intervalMs: 100,
  key: "publisher-test",
  publisher: "test",
  cooldown: "shared",
} as const;

for (const failure of ["connect", "command", "timeout", "reply"] as const) {
  test(`publisher ${failure} failures retain the shared unavailable outcome`, async () => {
    const cause =
      failure === "timeout"
        ? new TimeoutError({
            message: "Store command timed out",
            label: "publisher gate",
          })
        : new TypeError("Store unavailable");
    const slot = createPublisherRequestSlot(CONFIG, {
      redis: () => {
        if (failure === "connect") {
          throw cause;
        }
        return {
          send: () => {
            if (failure === "command" || failure === "timeout") {
              throw cause;
            }
            return "invalid";
          },
        };
      },
      sleep: async () => {},
    });
    const errors = [
      await rejectionOf(slot()),
      await rejectionOf(slot.tryReserve()),
      await rejectionOf(slot.readCooldown()),
      await rejectionOf(slot.defer(100)),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(LimiterStoreUnavailableError);
      expect(error).toHaveProperty("code", LIMITER_STORE_UNAVAILABLE.code);
      if (LimiterStoreUnavailableError.is(error)) {
        if (failure === "reply") {
          expect(error.cause).toHaveProperty("_tag", "PublisherGateReplyError");
        } else {
          expect(error.cause).toBe(cause);
        }
      }
    }
    const immediate = await rejectionOf(slot.reserveImmediately());
    expect(immediate).toBeInstanceOf(PublisherPacingStopped);
    if (PublisherPacingStopped.is(immediate)) {
      expect(immediate.status).toBe("pacing-unavailable");
      expect(immediate.cause).toBeInstanceOf(LimiterStoreUnavailableError);
    }
  });
}

test("publisher configuration refusals preserve their identity", async () => {
  const cause = new ActionAdmissionError({
    message: "Configuration incomplete",
    reason: "configuration_incomplete",
  });
  const slot = createPublisherRequestSlot(CONFIG, {
    redis: () => {
      throw cause;
    },
    sleep: async () => {},
  });
  expect(await rejectionOf(slot())).toBe(cause);
  const immediate = await rejectionOf(slot.reserveImmediately());
  expect(immediate).toBeInstanceOf(PublisherPacingStopped);
  if (PublisherPacingStopped.is(immediate)) {
    expect(immediate.cause).toBe(cause);
  }
});

test("publisher cancellation preserves the abort reason", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Cancelled", "AbortError");
  controller.abort(reason);
  const slot = createPublisherRequestSlot(CONFIG, {
    redis: () => {
      throw new TypeError("Cancelled requests must not open storage");
    },
    sleep: async () => {},
  });
  expect(await rejectionOf(slot(controller.signal))).toBe(reason);
  expect(await rejectionOf(slot.reserveImmediately(controller.signal))).toBe(
    reason,
  );
});
