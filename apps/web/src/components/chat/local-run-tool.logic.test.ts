import { describe, expect, test } from "bun:test";

import { localRunToolView } from "@/components/chat/local-run-tool.logic";

const view = (name: string, input: unknown, output?: unknown) =>
  localRunToolView({ name, input, output });

describe("a step a coding agent took on the member's computer", () => {
  test("a command shows its line, and a failed one its exit code", () => {
    expect(view("command_execution", { command: "rg lease" })).toEqual({
      titleKey: null,
      subtitle: { type: "text", text: "rg lease" },
    });
    expect(
      view(
        "command_execution",
        { command: "bun test" },
        { aggregated_output: "1 fail", exit_code: 1, status: "failed" },
      ),
    ).toEqual({
      titleKey: null,
      subtitle: { type: "command", command: "bun test", exitCode: 1 },
    });
    // Success needs no code; the status mark says it.
    expect(
      view("command_execution", { command: "ls" }, { exit_code: 0 }),
    ).toMatchObject({ subtitle: { type: "text", text: "ls" } });
  });

  test("a stored command from before the bound is shown within it, on one line", () => {
    const shown = view("command_execution", {
      command: `cat > notes.md <<'EOF'\nPrivate terms\nEOF`,
    });
    expect(shown?.subtitle).toEqual({
      type: "text",
      text: "cat > notes.md <<'EOF'…",
    });
  });

  test("a file change names its files", () => {
    expect(
      view("file_change", {
        changes: [
          { path: "drafts/lease.md", kind: "update" },
          { path: "drafts/notice.md", kind: "add" },
        ],
      }),
    ).toEqual({
      titleKey: null,
      subtitle: { type: "text", text: "drafts/lease.md, drafts/notice.md" },
    });
  });

  test("a read, a search, a fetch and a plan are named by their kind", () => {
    expect(
      view("harness_native_tool", {
        tool: "Read",
        detail: { kind: "read", path: "drafts/lease.md" },
      }),
    ).toEqual({
      titleKey: "chat.toolCall.readFile",
      subtitle: { type: "text", text: "drafts/lease.md" },
    });
    expect(
      view("harness_native_tool", {
        tool: "Grep",
        detail: { kind: "search", pattern: "termination", path: "drafts" },
      }),
    ).toEqual({
      titleKey: "chat.toolCall.searchFiles",
      subtitle: { type: "search", pattern: "termination", path: "drafts" },
    });
    expect(
      view("harness_native_tool", {
        tool: "Glob",
        detail: { kind: "search", pattern: "**/*.md" },
      }),
    ).toMatchObject({ subtitle: { type: "text", text: "**/*.md" } });
    expect(
      view("harness_native_tool", {
        tool: "WebFetch",
        detail: { kind: "fetch", url: "https://example.test/law" },
      }),
    ).toEqual({
      titleKey: "chat.tool.fetch_url",
      subtitle: { type: "text", text: "https://example.test/law" },
    });
    expect(
      view("harness_native_tool", {
        tool: "update_plan",
        detail: { kind: "plan", items: ["Read the lease", "Draft the notice"] },
      }),
    ).toEqual({
      titleKey: "chat.toolCall.updatePlan",
      subtitle: { type: "text", text: "Read the lease, Draft the notice" },
    });
  });

  test("any other native tool shows its name, and a malformed detail its name only", () => {
    expect(view("harness_native_tool", { tool: "Task" })).toEqual({
      titleKey: null,
      subtitle: { type: "text", text: "Task" },
    });
    expect(
      view("harness_native_tool", {
        tool: "Read",
        detail: { kind: "read", content: "Private text" },
      }),
    ).toEqual({ titleKey: null, subtitle: { type: "text", text: "Read" } });
  });

  test("a stella or connector call keeps its own row", () => {
    expect(view("search_case_law", { query: "lease" })).toBeNull();
    expect(view("mcp__docs__search", { query: "lease" })).toBeNull();
    expect(view("command_execution", { output: "not a command" })).toBeNull();
  });
});
