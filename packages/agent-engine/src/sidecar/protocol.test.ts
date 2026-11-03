import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  encodeSidecarMessage,
  parseSidecarHelloPreamble,
  parseSidecarHostLine,
  SIDECAR_HOLDER_MODES,
  SIDECAR_HOST_MESSAGE,
  SIDECAR_MAX_HELD_RUNS,
  SIDECAR_MAX_LINE_BYTES,
  SIDECAR_MESSAGE,
  SIDECAR_PROBE_FAILURES,
  SIDECAR_PROTOCOL,
  SIDECAR_REJECTIONS,
  sidecarHostMessageSchema,
  sidecarMessageSchema,
} from "./protocol";
import fixtures from "./protocol.fixtures.json";

const variantTypes = (
  options: readonly {
    readonly entries: { readonly type: { literal: string } };
  }[],
) => options.map(({ entries }) => entries.type.literal).toSorted();

describe("sidecar protocol fixtures", () => {
  test("carry the contract's version, limit and closed vocabularies", () => {
    expect(fixtures.vocabulary).toEqual({
      protocol: SIDECAR_PROTOCOL,
      maxLineBytes: SIDECAR_MAX_LINE_BYTES,
      maxHeldRuns: SIDECAR_MAX_HELD_RUNS,
      hostMessageTypes: Object.values(SIDECAR_HOST_MESSAGE),
      messageTypes: Object.values(SIDECAR_MESSAGE),
      rejections: [...SIDECAR_REJECTIONS],
      probeFailures: [...SIDECAR_PROBE_FAILURES],
      holderModes: [...SIDECAR_HOLDER_MODES],
    });
  });

  test("name exactly the schemas' message variants", () => {
    expect(variantTypes(sidecarHostMessageSchema.options)).toEqual(
      Object.values(SIDECAR_HOST_MESSAGE).toSorted(),
    );
    expect(variantTypes(sidecarMessageSchema.options)).toEqual(
      Object.values(SIDECAR_MESSAGE).toSorted(),
    );
  });

  test("cover every message type with a valid example", () => {
    expect(new Set(fixtures.valid.host.map(({ type }) => type))).toEqual(
      new Set(Object.values(SIDECAR_HOST_MESSAGE)),
    );
    expect(new Set(fixtures.valid.sidecar.map(({ type }) => type))).toEqual(
      new Set(Object.values(SIDECAR_MESSAGE)),
    );
  });

  test("parse every valid host line unchanged", () => {
    for (const message of fixtures.valid.host) {
      expect(parseSidecarHostLine(JSON.stringify(message))).toEqual({
        type: "message",
        message: v.parse(sidecarHostMessageSchema, message),
      });
      const reparsed: unknown = v.parse(sidecarHostMessageSchema, message);
      expect(reparsed).toEqual(message);
    }
  });

  test("encode every valid sidecar message unchanged", () => {
    for (const message of fixtures.valid.sidecar) {
      const parsed = v.parse(sidecarMessageSchema, message);
      const plain: unknown = parsed;
      expect(plain).toEqual(message);
      expect(encodeSidecarMessage(parsed)).toBe(`${JSON.stringify(message)}\n`);
    }
  });

  test("reject each refused host line for its own reason", () => {
    for (const { name, line, reason } of fixtures.rejected.host) {
      const parsed = parseSidecarHostLine(line);
      const outcome: unknown = {
        name,
        parsed: parsed.type,
        reason: "reason" in parsed ? parsed.reason : null,
      };
      expect(outcome).toEqual({
        name,
        parsed: "rejected",
        reason,
      });
    }
  });

  test("reject each refused sidecar message", () => {
    for (const { name, message } of fixtures.rejected.sidecar) {
      expect({
        name,
        ok: v.safeParse(sidecarMessageSchema, message).success,
      }).toEqual({
        name,
        ok: false,
      });
    }
  });

  test("an unknown type keeps its name, bounded, in the rejection", () => {
    expect(
      parseSidecarHostLine(JSON.stringify({ type: "x".repeat(200) })),
    ).toEqual({
      type: "rejected",
      reason: "unknown_type",
      messageType: "x".repeat(64),
    });
  });

  test("a hello of another protocol still yields its secret and version", () => {
    const secret = "ab".repeat(32);
    expect(
      parseSidecarHelloPreamble(
        JSON.stringify({ type: "hello", protocol: 9, secret, future: [1] }),
      ),
    ).toEqual({ type: "hello", protocol: 9, secret });
    for (const line of [
      JSON.stringify({ type: "hello", protocol: 2 }),
      JSON.stringify({ type: "ack", protocol: 2, secret }),
      "{not json",
    ]) {
      expect(parseSidecarHelloPreamble(line)).toBeNull();
    }
  });

  test("a line over the limit is refused before it is parsed", () => {
    const line = JSON.stringify({
      type: "shutdown",
      pad: "é".repeat(SIDECAR_MAX_LINE_BYTES / 2),
    });
    expect(parseSidecarHostLine(line)).toEqual({
      type: "rejected",
      reason: "too_large",
      messageType: null,
    });
  });
});
