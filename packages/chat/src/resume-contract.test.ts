import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import {
  chatResumeSnapshotSchema,
  chatTurnResumeProbeSchema,
} from "./resume-contract";
import type { ChatTurnResumeProbe } from "./resume-contract";

// The resume probe crosses a deploy: a page loaded before a release asks the
// server deployed after it where a turn stands, and a page reads the resume
// snapshot an earlier release stored with a message. A newer server may add
// fields anywhere in the probe, and an older snapshot lacks the optional
// fields added since: neither may stop the page from reading the turn.

const name = fc.string({ minLength: 1, maxLength: 12 });

type ResumeSnapshot = v.InferOutput<typeof chatResumeSnapshotSchema>;
type PendingInterrupt = NonNullable<
  ResumeSnapshot["pendingInterrupts"]
>[number];

const pendingInterrupt: fc.Arbitrary<PendingInterrupt> = fc.record(
  {
    expiresAt: fc.constant("2026-01-01T00:00:00.000Z"),
    id: name,
    message: fc.string(),
    metadata: fc.dictionary(name, fc.jsonValue(), { maxKeys: 2 }),
    reason: name,
    toolCallId: name,
  },
  { requiredKeys: ["id", "reason"] },
);

/** A snapshot of any release: every optional field may be absent. */
const resumeSnapshot: fc.Arbitrary<ResumeSnapshot> = fc.record(
  {
    pendingInterrupts: fc.array(pendingInterrupt, { maxLength: 3 }),
    resumeState: fc.record({ runId: name, threadId: name }),
  },
  { requiredKeys: ["resumeState"] },
);

const resumeProbe: fc.Arbitrary<ChatTurnResumeProbe> = fc.oneof(
  fc.record({ turnId: name, type: fc.constant("preparing") }),
  fc.record({ runId: name, turnId: name, type: fc.constant("running") }),
  fc.record(
    {
      resumeSnapshot,
      turnId: name,
      type: fc.constant("transcript"),
    },
    { requiredKeys: ["turnId", "type"] },
  ),
);

const futureFields = fc.array(
  fc.dictionary(fc.string({ minLength: 1, maxLength: 12 }), fc.jsonValue(), {
    minKeys: 1,
    maxKeys: 3,
  }),
  { minLength: 1, maxLength: 8 },
);

/** `value` as a page receives it: serialized to JSON text and parsed back,
 *  which a structured clone would not do (it keeps `undefined` fields). */
const overTheWire = (value: unknown): unknown => {
  const body = JSON.stringify(value);
  return JSON.parse(body);
};

/**
 * `value` as a newer server sends it: every object in it carries fields of
 * `additions` under names it does not use yet, and it crosses the wire as
 * JSON.
 */
const sentByNewerServer = (
  value: unknown,
  additions: readonly Record<string, unknown>[],
): { added: number; sent: unknown } => {
  let visited = 0;
  let added = 0;
  const extend = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(extend);
    }
    if (typeof node !== "object" || node === null) {
      return node;
    }
    const fields = additions[visited % additions.length] ?? {};
    visited += 1;
    const current = Object.entries(node).map(
      ([key, field]) => [key, extend(field)] as const,
    );
    const future = Object.entries(fields).filter(
      ([key]) => !Object.hasOwn(node, key),
    );
    added += future.length;
    return Object.fromEntries([...current, ...future]);
  };
  const sent = overTheWire(extend(value));
  return { added, sent };
};

describe("the chat resume contract across releases", () => {
  test("a probe from a newer server with fields the page does not know reads as the probe without them", () => {
    assertProperty(
      "a probe from a newer server with fields the page does not know reads as the probe without them",
      fc.property(resumeProbe, futureFields, (probe, additions) => {
        const { added, sent } = sentByNewerServer(probe, additions);
        // The fixture reaches the boundary: the sent probe has new fields.
        expect(added).toBeGreaterThan(0);
        const current = v.safeParse(chatTurnResumeProbeSchema, probe);
        const newer = v.safeParse(chatTurnResumeProbeSchema, sent);
        expect(current.success).toBe(true);
        expect(newer.success).toBe(true);
        expect(newer.output).toMatchObject(current.output ?? {});
      }),
    );
  });

  test("a resume snapshot stored by any release, with or without newer fields, still reads", () => {
    assertProperty(
      "a resume snapshot stored by any release, with or without newer fields, still reads",
      fc.property(resumeSnapshot, futureFields, (snapshot, additions) => {
        const stored = overTheWire(snapshot);
        const read = v.safeParse(chatResumeSnapshotSchema, stored);
        expect(read.success).toBe(true);
        expect(read.output).toEqual(snapshot);
        const { sent } = sentByNewerServer(snapshot, additions);
        const newer = v.safeParse(chatResumeSnapshotSchema, sent);
        expect(newer.success).toBe(true);
        expect(newer.output).toMatchObject(snapshot);
      }),
    );
  });
});
