import { describe, expect, test } from "bun:test";

import { HARNESS_TOOL_NAMES } from "../tool-parts";
import {
  type AcpToolCallState,
  boundedTail,
  harnessToolCall,
  mcpToolOfTitle,
  mergeToolCall,
  toolCallChanged,
} from "./tool-calls";
import { permissionDisposition } from "./turn";

const NAMES = { stella: "stella", others: ["stella_browser"] };

const started = mergeToolCall(null, {
  toolCallId: "call-1",
  title: "Read a.txt",
  kind: "read",
  status: "pending",
  rawInput: { path: "a.txt" },
  locations: [{ path: "a.txt" }],
});

describe("ACP tool call updates", () => {
  test("an update without a title keeps the title", () => {
    const next = mergeToolCall(started, {
      toolCallId: "call-1",
      status: "in_progress",
    });
    expect(next.title).toBe("Read a.txt");
    expect(next.status).toBe("in_progress");
    const blank = mergeToolCall(started, { toolCallId: "call-1", title: "  " });
    expect(blank.title).toBe("Read a.txt");
  });

  test("an update that only moves the locations is a change", () => {
    const moved = mergeToolCall(started, {
      toolCallId: "call-1",
      locations: [{ path: "b.txt", line: 3 }],
    });
    expect(toolCallChanged(started, moved)).toBe(true);
    const same = mergeToolCall(started, {
      toolCallId: "call-1",
      locations: [{ path: "a.txt" }],
    });
    expect(toolCallChanged(started, same)).toBe(false);
  });

  test("an empty input keeps the input; a new one is merged in", () => {
    expect(
      mergeToolCall(started, { toolCallId: "call-1", rawInput: {} }).rawInput,
    ).toEqual({ path: "a.txt" });
    expect(
      mergeToolCall(started, { toolCallId: "call-1", rawInput: { limit: 5 } })
        .rawInput,
    ).toEqual({ path: "a.txt", limit: 5 });
  });

  test("null clears content and locations; absent keeps them", () => {
    const cleared = mergeToolCall(started, {
      toolCallId: "call-1",
      locations: null,
    });
    expect(cleared.locations).toEqual([]);
    expect(mergeToolCall(started, { toolCallId: "call-1" }).locations).toEqual(
      started.locations,
    );
  });

  test("a later content list replaces the earlier one", () => {
    const first = mergeToolCall(started, {
      toolCallId: "call-1",
      content: [{ type: "content", content: { type: "text", text: "one" } }],
    });
    const second = mergeToolCall(first, {
      toolCallId: "call-1",
      content: [{ type: "content", content: { type: "text", text: "two" } }],
    });
    expect(second.content).toEqual([
      { type: "content", content: { type: "text", text: "two" } },
    ]);
  });
});

describe("ACP tool names", () => {
  test.each([
    ["mcp__stella__list_matters", "stella", "list_matters"],
    ["Running mcp_stella_list_matters", "stella", "list_matters"],
    ["Run mcp_stella_list_matters?", "stella", "list_matters"],
    ["stella__list_matters", "stella", "list_matters"],
    ["stella/list_matters", "stella", "list_matters"],
    ["list_matters (stella MCP Server)", "stella", "list_matters"],
    ["mcp__stella_browser__open", "stella_browser", "open"],
  ])("%s names %s's %s", (title, server, tool) => {
    expect(mcpToolOfTitle(title, NAMES)).toEqual({ server, tool });
  });

  test("a title of another server or none is no MCP call", () => {
    expect(mcpToolOfTitle("mcp__github__search", NAMES)).toBeNull();
    expect(mcpToolOfTitle("Read stella/notes.md now", NAMES)).toBeNull();
  });

  test("a call without a kind is a native tool under its title", () => {
    const call: AcpToolCallState = {
      ...started,
      kind: null,
      title: "Thinking",
    };
    expect(harnessToolCall(call, NAMES)).toEqual({
      id: "call-1",
      name: HARNESS_TOOL_NAMES.nativeTool,
      input: { tool: "Thinking" },
    });
  });

  test("a fetch with a query and no address is a web search", () => {
    const call: AcpToolCallState = {
      ...started,
      kind: "fetch",
      title: "Searching the web",
      rawInput: { query: "lease law" },
      locations: [],
    };
    expect(harnessToolCall(call, NAMES)).toEqual({
      id: "call-1",
      name: HARNESS_TOOL_NAMES.webSearch,
      input: { query: "lease law" },
    });
  });
});

describe("bounded output", () => {
  test("keeps the tail and never starts inside a surrogate pair", () => {
    expect(boundedTail("abcdef", 3)).toBe("def");
    const emoji = "x😀y";
    // The tail of 3 units starts on the pair's low half: it is dropped.
    expect(boundedTail(emoji, 2)).toBe("y");
    expect(boundedTail(emoji, 3)).toBe("😀y");
  });
});

describe("permission answers", () => {
  const workspaceDir = "/runs/chat-1";
  const policy = {
    network: "open",
    fs: "workspace",
    approvals: "ask",
  } as const;
  const call = (kind: string, paths: readonly string[]): AcpToolCallState => ({
    ...started,
    kind,
    locations: paths.map((path) => ({ path })),
  });
  const disposition = (
    candidate: AcpToolCallState,
    approvals: "ask" | "auto" = "ask",
  ) =>
    permissionDisposition({
      call: candidate,
      policy: { ...policy, approvals },
      workspaceDir,
      unreadablePaths: ["/runs", "/secrets"],
    });

  test("reads inside the run's folder are allowed", () => {
    expect(disposition(call("read", ["notes.md"]))).toBe("allow");
    expect(disposition(call("search", ["/runs/chat-1/docs"]))).toBe("allow");
  });

  test("anything touching an unreadable path is refused", () => {
    expect(disposition(call("read", ["/secrets/key"]))).toBe("deny");
    expect(disposition(call("edit", ["/runs/chat-2/a.md"]))).toBe("deny");
  });

  test("writes inside the folder ask at Ask and pass at Auto", () => {
    expect(disposition(call("edit", ["a.md"]))).toBe("ask");
    expect(disposition(call("edit", ["a.md"]), "auto")).toBe("allow");
  });

  test("fetching from the web asks at Ask and passes at Auto", () => {
    expect(disposition(call("fetch", []))).toBe("ask");
    expect(disposition(call("fetch", []), "auto")).toBe("allow");
  });

  test("commands and steps outside the folder always ask", () => {
    expect(disposition(call("execute", []), "auto")).toBe("ask");
    expect(disposition(call("read", ["/etc/hosts"]), "auto")).toBe("ask");
    expect(disposition(call("edit", []), "auto")).toBe("ask");
  });
});
