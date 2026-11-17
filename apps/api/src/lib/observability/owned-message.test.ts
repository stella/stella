import { TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  OWNED_MESSAGE,
  OWNED_MESSAGE_MAX_LENGTH,
  ownedMessage,
  ownedMessageOf,
} from "@/api/lib/observability/owned-message";
import type { OwnedMessage } from "@/api/lib/observability/owned-message";

class OwnedProbeError extends TaggedError("OwnedProbeError")<{
  message: string;
}> {
  readonly [OWNED_MESSAGE] = true;

  constructor(args: { message: OwnedMessage }) {
    super({ ...args });
  }
}

const LONG_MESSAGE =
  "A fixed message that keeps going well past the cap so the summary cannot grow with the text its author wrote. A fixed message that keeps going well past the cap so the summary cannot grow with the text its author wrote. A fixed message that keeps going well past the cap so the summary cannot grow with the text its author wrote.";

describe("owned failure messages", () => {
  test("an owned message is capped", () => {
    expect(LONG_MESSAGE.length).toBeGreaterThan(OWNED_MESSAGE_MAX_LENGTH);
    const summary = ownedMessageOf(
      new OwnedProbeError({ message: ownedMessage(LONG_MESSAGE) }),
    );
    expect(summary).toHaveLength(OWNED_MESSAGE_MAX_LENGTH);
    expect(summary).toBe(LONG_MESSAGE.slice(0, OWNED_MESSAGE_MAX_LENGTH));
  });

  test("an error that does not own its message has no summary", () => {
    expect(ownedMessageOf(new Error("Jana Novakova"))).toBeUndefined();
    expect(ownedMessageOf("a thrown string")).toBeUndefined();
  });

  test("a message built at runtime does not type as owned", () => {
    const received = Bun.randomUUIDv7();
    // @ts-expect-error a runtime string is not a literal
    ownedMessage(received);
    // @ts-expect-error a template with a runtime hole is not a literal
    ownedMessage(`Cannot load ${received}`);
    expect(String(ownedMessage("A literal"))).toBe("A literal");
  });
});
