import type { ModelMessage } from "@tanstack/ai";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { guardModelSystemPrompt } from "@/api/lib/chat/model-ingress-guard";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

import {
  guardedCompactedMessages,
  guardedLoopRecoveryPrompts,
} from "./stream-chat";

// The real capture and logger paths run (fingerprinting, attribute
// sanitization); only their sinks are in memory.
let analytics: RecordingAnalytics;
let logs: RecordingLogger;

beforeEach(() => {
  analytics = installRecordingAnalytics();
  logs = installRecordingLogger();
});

afterEach(() => {
  analytics.restore();
  logs.restore();
});

const WS_A = toSafeId<"workspace">("0dc54d0c-10d7-501d-897e-e801dbd0998c");
const PUBLIC_UUID = "7c0f7d51-70a4-4d64-9f0e-0a4d64e9911b";
const BASE_SYSTEM = guardModelSystemPrompt({
  system: "You are stella. Matter scope: mat_1.",
  workspaceIds: [WS_A],
});

// The runtime middleware rebuilds both surfaces after the ingress guard has
// already cleared them, so these cover the re-entry: the guard can fire on
// what the middleware produces, and clean rewrites pass through untouched.
describe("mid-loop rewrites re-enter the model-ingress guard", () => {
  test("redacts a tenant id an org tool name drags into the loop-recovery prompt", () => {
    const [prompt] = guardedLoopRecoveryPrompts({
      baseSystem: BASE_SYSTEM,
      detection: {
        type: "tool-call-loop",
        repetitionCount: 3,
        signature: "sig",
        toolName: `mcp__crm__${WS_A}`,
      },
      tenantWorkspaceIds: [WS_A],
    });

    expect(prompt).toContain("[internal-id-removed]");
    expect(prompt).not.toContain(WS_A);
    // The base prompt survives: recovery still carries the turn's scaffold.
    expect(prompt).toContain("Matter scope: mat_1.");
    // Redaction hits on rewrites are routine (the id arrived through an org
    // tool name), so they log rather than capture.
    expect(analytics.exceptions()).toEqual([]);
    expect(logs.at("WARN")).toEqual([
      {
        severityText: "WARN",
        message: "chat.model_ingress_redacted",
        attributes: {
          pathCount: "1",
          paths: "$",
          surface: "system-prompt-mixed",
        },
      },
    ]);
    expect(JSON.stringify(logs.records)).not.toContain(WS_A);
  });

  test("passes a clean loop-recovery prompt through unchanged and silent", () => {
    const [prompt] = guardedLoopRecoveryPrompts({
      baseSystem: BASE_SYSTEM,
      detection: {
        type: "tool-call-loop",
        repetitionCount: 3,
        signature: "sig",
        toolName: "search_case_law",
      },
      tenantWorkspaceIds: [WS_A],
    });

    expect(prompt).toContain("search_case_law");
    expect(prompt).not.toContain("[internal-id-removed]");
    expect(analytics.exceptions()).toEqual([]);
    expect(logs.at("WARN")).toEqual([]);
  });

  test("redacts a tenant id the compaction summary reintroduces", () => {
    const previous: ModelMessage[] = [
      { role: "user", content: "Earlier turn." },
    ];
    const compacted: ModelMessage[] = [
      {
        role: "user",
        content: `Summary: the user worked in workspace ${WS_A} on decision ${PUBLIC_UUID}.`,
      },
    ];

    const guarded = guardedCompactedMessages({
      compacted,
      previous,
      tenantWorkspaceIds: [WS_A],
    });

    const dispatched = JSON.stringify(guarded);
    expect(dispatched).not.toContain(WS_A);
    expect(dispatched).toContain("[internal-id-removed]");
    // Membership-exact: the public decision id survives compaction.
    expect(dispatched).toContain(PUBLIC_UUID);
    expect(analytics.exceptions()).toEqual([]);
    expect(logs.at("WARN")).toEqual([
      {
        severityText: "WARN",
        message: "chat.model_ingress_redacted",
        attributes: {
          pathCount: "1",
          paths: "$[0].content",
          surface: "messages",
        },
      },
    ]);
    expect(JSON.stringify(logs.records)).not.toContain(WS_A);
  });

  test("keeps a clean summary intact and skips the patch when nothing compacted", () => {
    const previous: ModelMessage[] = [
      { role: "user", content: "Earlier turn." },
    ];
    const compacted: ModelMessage[] = [
      { role: "user", content: `Summary: decision ${PUBLIC_UUID} reviewed.` },
    ];

    // What the middleware hands back to the SDK's plain config.
    const dispatched: ModelMessage[] | undefined = guardedCompactedMessages({
      compacted,
      previous,
      tenantWorkspaceIds: [WS_A],
    });
    expect(dispatched).toEqual(compacted);
    // Compaction that changed nothing must not rebuild the history.
    expect(
      guardedCompactedMessages({
        compacted: previous,
        previous,
        tenantWorkspaceIds: [WS_A],
      }),
    ).toBeUndefined();
    expect(analytics.exceptions()).toEqual([]);
    expect(logs.at("WARN")).toEqual([]);
  });
});
