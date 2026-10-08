import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { recoverChatSecretSubmission } from "./chat-secret-retry";

/** Answers each select with the next queued rows and every lock as held. */
const scriptedTransaction = (selects: unknown[][]) => {
  const select = () => {
    const rows = selects.shift() ?? [];
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: async () => rows,
    };
    return chain;
  };
  const handle = { execute: async () => [{ id: "locked" }], select };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- scripted handle answers only the calls recovery makes
  return handle as unknown as Transaction;
};

describe("chat secret retry lock order", () => {
  test("leaves the turn fence acquirable when the receipt vanished under its lock", async () => {
    const scope = {
      organizationId: mintAuthProviderId<"organization">(),
      userId: mintAuthProviderId<"user">(),
      threadId: createSafeId<"chatThread">(),
      toolCallId: "vanished-request",
    };
    const tx = scriptedTransaction([
      [{ id: Bun.randomUUIDv7() }],
      [{ status: "awaiting-user" }],
      [],
    ]);

    const outcome = await recoverChatSecretSubmission({
      tx,
      ...scope,
      secretDecision: { decision: "decline" },
    });
    expect(outcome).toEqual({ kind: "absent" });

    // The first-submission path fences the turn next; that must not invert rank.
    expect(
      await withAggregateLock({ aggregate: "chatTurn", tx, id: scope }),
    ).toEqual({ status: "locked" });
  });
});
