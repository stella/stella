import type { EventType, ModelMessage, StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { AGENT_HARNESSES } from "./agent-harness";
import {
  DESKTOP_RUNNER_APPROVAL_DECISIONS,
  DESKTOP_RUNNER_APPROVAL_KINDS,
  DESKTOP_RUNNER_DESKTOP_MESSAGE,
  DESKTOP_RUNNER_FRAME_REJECTION,
  DESKTOP_RUNNER_FS_POLICIES,
  DESKTOP_RUNNER_HARNESS_CAPABILITIES,
  DESKTOP_RUNNER_HARNESS_STATE,
  DESKTOP_RUNNER_MAX_FRAME_BYTES,
  type DESKTOP_RUNNER_MESSAGE_ROLES,
  DESKTOP_RUNNER_NETWORK_POLICIES,
  DESKTOP_RUNNER_PROTOCOL,
  DESKTOP_RUNNER_REJECT_REASONS,
  DESKTOP_RUNNER_RUN_OUTCOMES,
  DESKTOP_RUNNER_SERVER_MESSAGE,
  type DesktopRunnerDesktopMessage,
  desktopRunnerDesktopMessageSchema,
  type DesktopRunnerHarnessReport,
  type DesktopRunnerServerMessage,
  desktopRunnerServerMessageSchema,
  parseDesktopRunnerFrame,
} from "./desktop-runner";
import fixtures from "./desktop-runner.fixtures.json";

type Same<TLeft, TRight> = [TLeft] extends [TRight]
  ? [TRight] extends [TLeft]
    ? true
    : false
  : false;

/** The socket checks chunk types against exactly what TanStack can emit. */
const chunkTypesMatchTanStack: Same<`${StreamChunk["type"]}`, `${EventType}`> =
  true;
const rolesMatchTanStack: Same<
  (typeof DESKTOP_RUNNER_MESSAGE_ROLES)[number],
  ModelMessage["role"]
> = true;

const parseDesktop = (message: unknown) =>
  parseDesktopRunnerFrame(JSON.stringify(message));

const parsedDesktop = (message: unknown): DesktopRunnerDesktopMessage => {
  const frame = parseDesktop(message);
  if (frame.type !== "message") {
    return panic(`fixture did not parse: ${JSON.stringify(frame)}`);
  }
  return frame.message;
};

const parsedServer = (message: unknown): DesktopRunnerServerMessage =>
  v.parse(desktopRunnerServerMessageSchema, message);

const sorted = (values: Iterable<string>) => [...values].toSorted();

/** A parsed message, compared as plain JSON with the fixture it came from. */
const reparsed = (direction: string, message: unknown): unknown =>
  direction === "desktop" ? parsedDesktop(message) : parsedServer(message);

const normalized = (lists: Record<string, readonly string[]>) =>
  Object.fromEntries(
    Object.entries(lists).map(([name, values]) => [
      name,
      sorted(new Set(values)),
    ]),
  );

const variantTypes = (
  options: readonly {
    readonly entries: { readonly type: { literal: string } };
  }[],
) => sorted(options.map(({ entries }) => entries.type.literal));

type Hello = Extract<DesktopRunnerDesktopMessage, { type: "hello" }>;

const firstHello = (): Hello => {
  const message = parsedDesktop(fixtures.valid.desktop[0]);
  return message.type === "hello"
    ? message
    : panic("the first desktop fixture is a hello");
};

describe("desktop runner fixtures", () => {
  test("bind TanStack's chunk types and message roles", () => {
    expect(chunkTypesMatchTanStack).toBe(true);
    expect(rolesMatchTanStack).toBe(true);
  });

  test("carry the contract's protocol, limits and closed vocabularies", () => {
    expect(fixtures.vocabulary).toEqual({
      protocol: DESKTOP_RUNNER_PROTOCOL,
      maxFrameBytes: DESKTOP_RUNNER_MAX_FRAME_BYTES,
      harnesses: [...AGENT_HARNESSES],
      harnessStates: Object.values(DESKTOP_RUNNER_HARNESS_STATE),
      harnessCapabilities: [...DESKTOP_RUNNER_HARNESS_CAPABILITIES],
      runRejectReasons: [...DESKTOP_RUNNER_REJECT_REASONS],
      approvalKinds: [...DESKTOP_RUNNER_APPROVAL_KINDS],
      approvalDecisions: [...DESKTOP_RUNNER_APPROVAL_DECISIONS],
      runOutcomes: [...DESKTOP_RUNNER_RUN_OUTCOMES],
      networkPolicies: [...DESKTOP_RUNNER_NETWORK_POLICIES],
      fsPolicies: [...DESKTOP_RUNNER_FS_POLICIES],
      desktopMessageTypes: Object.values(DESKTOP_RUNNER_DESKTOP_MESSAGE),
      serverMessageTypes: Object.values(DESKTOP_RUNNER_SERVER_MESSAGE),
    });
  });

  test("name exactly the schema's message variants", () => {
    expect(variantTypes(desktopRunnerDesktopMessageSchema.options)).toEqual(
      sorted(Object.values(DESKTOP_RUNNER_DESKTOP_MESSAGE)),
    );
    expect(variantTypes(desktopRunnerServerMessageSchema.options)).toEqual(
      sorted(Object.values(DESKTOP_RUNNER_SERVER_MESSAGE)),
    );
  });

  test("every valid message parses to itself", () => {
    for (const message of fixtures.valid.desktop) {
      expect(reparsed("desktop", message)).toEqual(message);
    }
    for (const message of fixtures.valid.server) {
      expect(reparsed("server", message)).toEqual(message);
    }
  });

  test("valid messages cover every message type and closed value", () => {
    const desktop = fixtures.valid.desktop.map(parsedDesktop);
    const server = fixtures.valid.server.map(parsedServer);
    const reports: DesktopRunnerHarnessReport[] = desktop.flatMap((message) => {
      if (message.type === "hello") {
        return message.harnesses;
      }
      return message.type === "harness.status" ? [message.harness] : [];
    });
    const starts = server.flatMap((message) =>
      message.type === "run.start" ? [message] : [],
    );
    const { protocol, maxFrameBytes, ...vocabularies } = fixtures.vocabulary;
    expect({ protocol, maxFrameBytes }).toEqual({
      protocol: DESKTOP_RUNNER_PROTOCOL,
      maxFrameBytes: DESKTOP_RUNNER_MAX_FRAME_BYTES,
    });
    expect(
      normalized({
        desktopMessageTypes: desktop.map(({ type }) => type),
        serverMessageTypes: server.map(({ type }) => type),
        harnesses: [
          ...reports.map(({ id }) => id),
          ...starts.map(({ harness }) => harness),
        ],
        harnessStates: reports.map(({ state }) => state),
        harnessCapabilities: reports.flatMap((report) =>
          report.state === "ready" ? report.capabilities : [],
        ),
        runRejectReasons: desktop.flatMap((message) =>
          message.type === "run.rejected" ? [message.reason] : [],
        ),
        approvalKinds: desktop.flatMap((message) =>
          message.type === "run.approval_request" ? [message.kind] : [],
        ),
        approvalDecisions: server.flatMap((message) =>
          message.type === "run.approval" ? [message.decision] : [],
        ),
        runOutcomes: desktop.flatMap((message) =>
          message.type === "run.finished" ? [message.outcome] : [],
        ),
        networkPolicies: starts.map(({ policy }) => policy.network),
        fsPolicies: starts.map(({ policy }) => policy.fs),
      }),
    ).toEqual(normalized(vocabularies));
  });

  test("unknown fields are dropped, chunk fields are kept", () => {
    for (const { direction, input, parsed } of fixtures.unknownFields) {
      expect(input).not.toEqual(parsed);
      expect(reparsed(direction, input)).toEqual(parsed);
    }
  });

  test("rejected desktop messages name why", () => {
    for (const { message, name, reason } of fixtures.rejected.desktop) {
      expect({ name, frame: parseDesktop(message) }).toMatchObject({
        name,
        frame: { type: "rejected", reason },
      });
    }
  });

  test("rejected server messages do not parse", () => {
    for (const { message, name } of fixtures.rejected.server) {
      expect({
        name,
        success: v.safeParse(desktopRunnerServerMessageSchema, message).success,
      }).toEqual({ name, success: false });
    }
  });
});

describe("desktop runner frames", () => {
  const hello = firstHello();

  test("accept the current protocol and the one before it", () => {
    expect(Math.max(1, DESKTOP_RUNNER_PROTOCOL.current - 1)).toBe(
      DESKTOP_RUNNER_PROTOCOL.minimum,
    );
    for (const protocol of [
      DESKTOP_RUNNER_PROTOCOL.minimum,
      DESKTOP_RUNNER_PROTOCOL.current,
    ]) {
      expect(parseDesktop({ ...hello, protocol }).type).toBe("message");
    }
  });

  test("report an unsupported protocol before reading the rest of hello", () => {
    for (const protocol of [
      DESKTOP_RUNNER_PROTOCOL.minimum - 1,
      DESKTOP_RUNNER_PROTOCOL.current + 1,
    ]) {
      expect(
        parseDesktop({ type: "hello", protocol, harnesses: "changed" }),
      ).toEqual({ type: "unsupported_protocol", protocol });
    }
  });

  test("reject frames that are not JSON objects with a type", () => {
    expect(parseDesktopRunnerFrame("{")).toEqual({
      type: "rejected",
      reason: DESKTOP_RUNNER_FRAME_REJECTION.notJson,
      messageType: null,
    });
    for (const frame of ["[]", "null", '{"type":7}']) {
      expect(parseDesktopRunnerFrame(frame)).toEqual({
        type: "rejected",
        reason: DESKTOP_RUNNER_FRAME_REJECTION.invalid,
        messageType: null,
      });
    }
  });

  test("bound an unknown type before reporting it", () => {
    expect(parseDesktop({ type: "x".repeat(1000) })).toEqual({
      type: "rejected",
      reason: DESKTOP_RUNNER_FRAME_REJECTION.unknownType,
      messageType: "x".repeat(64),
    });
  });

  test("measure the frame limit in UTF-8 bytes", () => {
    const sized = (delta: string) =>
      JSON.stringify({
        type: DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent,
        runId: "0192f3a0-6b1c-7d2e-8f30-000000000001",
        seq: 1,
        chunk: { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta },
      });
    const overhead = new TextEncoder().encode(sized("")).byteLength;
    // Two UTF-8 bytes per code unit: the frame fits in code units long before
    // it fits in bytes, so a length check alone would accept the larger one.
    const room = DESKTOP_RUNNER_MAX_FRAME_BYTES - overhead;
    const delta = `${"é".repeat(Math.floor(room / 2))}${"a".repeat(room % 2)}`;
    const fits = sized(delta);
    expect(new TextEncoder().encode(fits).byteLength).toBe(
      DESKTOP_RUNNER_MAX_FRAME_BYTES,
    );
    expect(parseDesktopRunnerFrame(fits).type).toBe("message");
    const over = sized(`${delta}a`);
    expect(over.length).toBeLessThan(DESKTOP_RUNNER_MAX_FRAME_BYTES);
    expect(parseDesktopRunnerFrame(over)).toEqual({
      type: "rejected",
      reason: DESKTOP_RUNNER_FRAME_REJECTION.tooLarge,
      messageType: null,
    });
  });

  test("list each harness, capability, model and run once", () => {
    const [ready] = hello.harnesses;
    const [run] = hello.activeRuns;
    if (ready?.state !== "ready" || run === undefined) {
      panic("the first hello reports a ready harness and a run");
    }
    const [model] = ready.models;
    for (const duplicate of [
      { ...hello, activeRuns: [run, run] },
      { ...hello, harnesses: [ready, ready] },
      {
        type: "harness.status",
        harness: { ...ready, capabilities: ["approvals", "approvals"] },
      },
      { type: "harness.status", harness: { ...ready, models: [model, model] } },
      { type: "harness.status", harness: { ...ready, models: [] } },
    ]) {
      expect(parseDesktop(duplicate)).toMatchObject({
        type: "rejected",
        reason: DESKTOP_RUNNER_FRAME_REJECTION.invalid,
      });
    }
  });
});
