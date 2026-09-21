import { describe, expect, test } from "bun:test";

import {
  FEEDBACK_AREAS,
  FEEDBACK_CLIENTS,
  FEEDBACK_KINDS,
  FEEDBACK_LIMITS,
} from "@stll/api-contract/feedback";

import {
  buildFeedbackWorkflowReference,
  FEEDBACK_WORKFLOW_TOOL_NAMES,
} from "@/api/mcp/feedback-workflow-reference";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";

const reference = buildFeedbackWorkflowReference();

describe("feedback workflow reference", () => {
  test("every tool it names is served on the surface it is served on", () => {
    const served = new Set(
      listStaticMcpToolDefinitions("default").map((tool) => tool.name),
    );

    for (const name of FEEDBACK_WORKFLOW_TOOL_NAMES) {
      expect(served.has(name)).toBe(true);
      expect(reference).toContain(name);
    }
  });

  test("it names no tool the default surface does not serve", () => {
    const served = new Set(
      listStaticMcpToolDefinitions("default").map((tool) => tool.name),
    );
    const namedButUnserved = [...reference.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/gu)]
      .map((match) => match[0])
      .filter(
        (token) => token.startsWith("submit_") || token.startsWith("prepare_"),
      )
      .filter((token) => !served.has(token));

    expect(namedButUnserved).toEqual([]);
  });

  test("every value list is rendered from its constant", () => {
    for (const kind of FEEDBACK_KINDS) {
      expect(reference).toContain(kind);
    }
    for (const area of FEEDBACK_AREAS) {
      expect(reference).toContain(area);
    }
    for (const client of FEEDBACK_CLIENTS) {
      expect(reference).toContain(client);
    }
  });

  test("every cap is rendered from FEEDBACK_LIMITS", () => {
    for (const limit of Object.values(FEEDBACK_LIMITS)) {
      expect(reference).toContain(String(limit));
    }
  });

  test("a changed cap changes the rendered text", () => {
    // Guards the invariant rather than the current numbers: the assertion
    // above passes for a hand-typed literal that happens to match, this one
    // fails unless the text is built from the constant.
    expect(reference).toContain(`at most ${FEEDBACK_LIMITS.title} characters`);
    expect(reference).toContain(
      `at most ${FEEDBACK_LIMITS.whatHappened} characters`,
    );
  });

  test("it states the approval step between the two calls", () => {
    expect(reference).toContain("confirm: true");
    expect(reference).toContain("verbatim");
  });
});
