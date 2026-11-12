import type { EventType, ModelMessage, StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { AGENT_HARNESSES } from "./agent-harness";
import { CHAT_LOCAL_RUN_TOOL_LIMITS } from "./chat-local-run-tool";
import {
  DESKTOP_RUNNER_ANSWER_LIMITS,
  DESKTOP_RUNNER_APPROVAL_DECISIONS,
  DESKTOP_RUNNER_APPROVAL_KINDS,
  DESKTOP_RUNNER_APPROVAL_MODES,
  DESKTOP_RUNNER_CLOSE,
  DESKTOP_RUNNER_DESKTOP_ID_HEADER,
  DESKTOP_RUNNER_DESKTOP_MESSAGE,
  DESKTOP_RUNNER_FOLDER_RESTORE_OUTCOMES,
  DESKTOP_RUNNER_FRAME_REJECTION,
  DESKTOP_RUNNER_FS_POLICIES,
  DESKTOP_RUNNER_HARNESS_CAPABILITIES,
  DESKTOP_RUNNER_HARNESS_STATE,
  DESKTOP_RUNNER_HARNESS_UNAVAILABLE_REASONS,
  DESKTOP_RUNNER_LIMITS,
  DESKTOP_RUNNER_MAX_FRAME_BYTES,
  type DESKTOP_RUNNER_MESSAGE_ROLES,
  DESKTOP_RUNNER_NETWORK_POLICIES,
  DESKTOP_RUNNER_PATH,
  DESKTOP_RUNNER_POLICY_REASONS,
  DESKTOP_RUNNER_POLICY_VIOLATION_CODE,
  DESKTOP_RUNNER_PROTOCOL,
  DESKTOP_RUNNER_REASONING_EFFORTS,
  DESKTOP_RUNNER_REJECT_REASONS,
  DESKTOP_RUNNER_RUN_OUTCOMES,
  DESKTOP_RUNNER_SERVER_MESSAGE,
  DESKTOP_RUNNER_TIMING,
  desktopRunnerAttachmentPath,
  desktopRunnerAttachmentPathSchema,
  desktopRunnerAttachmentSchema,
  type DesktopRunnerDesktopMessage,
  desktopRunnerDesktopMessageSchema,
  type DesktopRunnerHarnessReport,
  desktopRunnerHarnessReportSchema,
  type DesktopRunnerServerMessage,
  desktopRunnerServerMessageSchema,
  knownReasoningEfforts,
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

  test("carry the contract's protocol, endpoint, close codes, timings and closed vocabularies", () => {
    expect(fixtures.vocabulary).toEqual({
      protocol: DESKTOP_RUNNER_PROTOCOL,
      maxFrameBytes: DESKTOP_RUNNER_MAX_FRAME_BYTES,
      runLimits: {
        maxMessagesPerRun: DESKTOP_RUNNER_LIMITS.maxMessagesPerRun,
        maxMessageBytesPerRun: DESKTOP_RUNNER_LIMITS.maxMessageBytesPerRun,
      },
      path: DESKTOP_RUNNER_PATH,
      desktopIdHeader: DESKTOP_RUNNER_DESKTOP_ID_HEADER,
      close: DESKTOP_RUNNER_CLOSE,
      policyViolationCode: DESKTOP_RUNNER_POLICY_VIOLATION_CODE,
      policyReasons: [...DESKTOP_RUNNER_POLICY_REASONS],
      timing: DESKTOP_RUNNER_TIMING,
      harnesses: [...AGENT_HARNESSES],
      harnessStates: Object.values(DESKTOP_RUNNER_HARNESS_STATE),
      harnessCapabilities: [...DESKTOP_RUNNER_HARNESS_CAPABILITIES],
      harnessUnavailableReasons: [
        ...DESKTOP_RUNNER_HARNESS_UNAVAILABLE_REASONS,
      ],
      runRejectReasons: [...DESKTOP_RUNNER_REJECT_REASONS],
      approvalKinds: [...DESKTOP_RUNNER_APPROVAL_KINDS],
      approvalDecisions: [...DESKTOP_RUNNER_APPROVAL_DECISIONS],
      runOutcomes: [...DESKTOP_RUNNER_RUN_OUTCOMES],
      networkPolicies: [...DESKTOP_RUNNER_NETWORK_POLICIES],
      fsPolicies: [...DESKTOP_RUNNER_FS_POLICIES],
      approvalModes: [...DESKTOP_RUNNER_APPROVAL_MODES],
      reasoningEfforts: [...DESKTOP_RUNNER_REASONING_EFFORTS],
      desktopMessageTypes: Object.values(DESKTOP_RUNNER_DESKTOP_MESSAGE),
      serverMessageTypes: Object.values(DESKTOP_RUNNER_SERVER_MESSAGE),
      answerLimits: DESKTOP_RUNNER_ANSWER_LIMITS,
      folderRestoreOutcomes: [...DESKTOP_RUNNER_FOLDER_RESTORE_OUTCOMES],
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
    // The socket's path, header, close codes and timings are not message
    // values; the vocabulary test above binds them.
    const {
      protocol,
      maxFrameBytes,
      runLimits: _runLimits,
      path: _path,
      desktopIdHeader: _desktopIdHeader,
      close: _close,
      policyViolationCode: _policyViolationCode,
      policyReasons: _policyReasons,
      timing: _timing,
      answerLimits: _answerLimits,
      ...vocabularies
    } = fixtures.vocabulary;
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
        harnessUnavailableReasons: reports.flatMap((report) =>
          report.state === "unavailable" ? [report.reason] : [],
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
        folderRestoreOutcomes: desktop.flatMap((message) =>
          message.type === "folder.restored" ? [message.outcome] : [],
        ),
        networkPolicies: starts.map(({ policy }) => policy.network),
        fsPolicies: starts.map(({ policy }) => policy.fs),
        approvalModes: [
          ...starts.map(({ policy }) => policy.approvals),
          ...reports.flatMap((report) =>
            report.state === "ready" ? report.approvalModes : [],
          ),
        ],
        reasoningEfforts: [
          ...starts.flatMap(({ reasoningEffort }) =>
            reasoningEffort === null ? [] : [reasoningEffort],
          ),
          ...reports.flatMap((report) =>
            report.state === "ready"
              ? report.models.flatMap(
                  ({ reasoningEfforts }) => reasoningEfforts,
                )
              : [],
          ),
        ],
      }),
    ).toEqual(normalized(vocabularies));
  });

  test("a ready report from before approval modes offers the default alone", () => {
    const report = {
      state: "ready",
      id: "codex",
      version: "0.48.0",
      capabilities: ["approvals"],
      models: [{ id: "model-large", label: "Large model" }],
    };
    const parsed = v.safeParse(desktopRunnerHarnessReportSchema, report);
    expect(parsed.success).toBe(true);
    expect(parsed.output).toMatchObject({ approvalModes: ["ask"] });
  });

  test("a model reported before reasoning efforts offers none", () => {
    const parsed = v.safeParse(desktopRunnerHarnessReportSchema, {
      state: "ready",
      id: "codex",
      version: "0.48.0",
      capabilities: ["approvals"],
      models: [{ id: "model-large", label: "Large model" }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.output).toMatchObject({
      models: [{ id: "model-large", reasoningEfforts: [] }],
    });
  });

  test("a harness's efforts keep the ones the contract carries, once each, weakest first", () => {
    expect(knownReasoningEfforts(["high", "turbo", "low", "high"])).toEqual([
      "low",
      "high",
    ]);
    expect(knownReasoningEfforts([])).toEqual([]);
  });

  test("an attached file's path stays in its own folder", () => {
    const fileId = "019a0000-0000-7000-8000-000000000001";
    const accepted = desktopRunnerAttachmentPath(fileId, "smlouva o dílo.pdf");
    expect(v.is(desktopRunnerAttachmentPathSchema, accepted)).toBe(true);
    for (const path of [
      `attachments/${fileId}/../../secrets.txt`,
      `attachments/${fileId}/..`,
      `attachments/${fileId}/.`,
      `attachments/${fileId}/a/b.pdf`,
      `attachments/${fileId}/a\\b.pdf`,
      `attachments/not-a-file-id/a.pdf`,
      `/attachments/${fileId}/a.pdf`,
      `other/${fileId}/a.pdf`,
    ]) {
      expect({
        path,
        ok: v.is(desktopRunnerAttachmentPathSchema, path),
      }).toEqual({ path, ok: false });
    }
  });

  test("a long name keeps its extension and fits every filesystem", () => {
    const fileId = "019a0000-0000-7000-8000-000000000001";
    const bounded = desktopRunnerAttachmentPath(
      fileId,
      `${"š".repeat(300)}.pdf`,
    );
    expect(v.is(desktopRunnerAttachmentPathSchema, bounded)).toBe(true);
    const name = bounded.split("/").at(-1) ?? "";
    expect(Array.from(name)).toHaveLength(120);
    expect(name.endsWith(".pdf")).toBe(true);
  });

  test("an attached file is only copied over https", () => {
    const path = desktopRunnerAttachmentPath(
      "019a0000-0000-7000-8000-000000000001",
      "a.pdf",
    );
    expect(
      v.is(desktopRunnerAttachmentSchema, {
        path,
        url: "https://files.example/a",
      }),
    ).toBe(true);
    expect(
      v.is(desktopRunnerAttachmentSchema, {
        path,
        url: "http://files.example/a",
      }),
    ).toBe(false);
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

describe("question answers", () => {
  const answer = (answers: unknown) => ({
    type: DESKTOP_RUNNER_SERVER_MESSAGE.runAnswer,
    runId: "0192f3a0-6b1c-7d2e-8f30-000000000001",
    requestId: "0192f3a0-6b1c-7d2e-8f30-0000000000b1",
    answers,
  });
  const parses = (answers: unknown) =>
    v.safeParse(desktopRunnerServerMessageSchema, answer(answers)).success;
  const {
    maxQuestions,
    maxAnswersPerQuestion,
    maxAnswerLength,
    maxQuestionIdLength,
  } = DESKTOP_RUNNER_ANSWER_LIMITS;
  const questions = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`q${String(index)}`, ["a"]]),
    );

  test("take each bound and refuse one past it", () => {
    const cases: [string, unknown, unknown][] = [
      ["questions", questions(maxQuestions), questions(maxQuestions + 1)],
      [
        "answers per question",
        { tone: Array.from({ length: maxAnswersPerQuestion }, () => "a") },
        { tone: Array.from({ length: maxAnswersPerQuestion + 1 }, () => "a") },
      ],
      [
        "answer length",
        { tone: ["a".repeat(maxAnswerLength)] },
        { tone: ["a".repeat(maxAnswerLength + 1)] },
      ],
      [
        "question id length",
        { ["q".repeat(maxQuestionIdLength)]: ["a"] },
        { ["q".repeat(maxQuestionIdLength + 1)]: ["a"] },
      ],
    ];
    for (const [name, atBound, pastBound] of cases) {
      expect({
        name,
        atBound: parses(atBound),
        past: parses(pastBound),
      }).toEqual({ name, atBound: true, past: false });
    }
  });

  test("count lengths in UTF-16 code units", () => {
    // Two UTF-8 bytes each, one code unit: the bound is on code units.
    expect(parses({ tone: ["é".repeat(maxAnswerLength)] })).toBe(true);
  });
});

describe("approval summaries", () => {
  test("a long or multi-line summary is kept as one bounded line, not refused", () => {
    const parsed = v.parse(desktopRunnerDesktopMessageSchema, {
      type: "run.approval_request",
      runId: "0192f3a0-6b1c-7d2e-8f30-000000000001",
      seq: 4,
      requestId: "0192f3a0-6b1c-7d2e-8f30-0000000000a1",
      kind: "command",
      summary: `cat > notes.md <<'EOF'\nPrivate terms\nEOF ${"x".repeat(3000)}`,
    });
    expect(parsed).toMatchObject({
      type: "run.approval_request",
      summary: "cat > notes.md <<'EOF'…",
    });
    const long = v.parse(desktopRunnerDesktopMessageSchema, {
      type: "run.approval_request",
      runId: "0192f3a0-6b1c-7d2e-8f30-000000000001",
      seq: 5,
      requestId: "0192f3a0-6b1c-7d2e-8f30-0000000000a2",
      kind: "command",
      summary: "y".repeat(3000),
    });
    expect(
      long.type === "run.approval_request" ? long.summary.length : null,
    ).toBe(CHAT_LOCAL_RUN_TOOL_LIMITS.approval);
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
