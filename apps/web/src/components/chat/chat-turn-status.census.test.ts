import { expect, test } from "bun:test";

const OWNER = "src/components/chat/chat-turn-status.tsx";
const ALLOWED_NON_TURN_LOADERS = {
  "src/components/chat/ask-user-card.tsx": "submitting a user answer",
  "src/components/chat/chat-message-actions-menu.tsx": "export action",
  "src/components/chat/chat-prompt-improve-button.tsx": "prompt rewrite action",
  "src/components/chat/connect-connector-card.tsx": "connector authorization",
  "src/components/chat/message-export-menu.tsx": "message export action",
  "src/components/chat/needs-matter-card.tsx": "matter creation action",
  "src/components/chat/request-secret-card.tsx": "secret submission action",
  "src/components/chat/side-panel-chat-status.tsx":
    "side-panel connection status",
  "src/components/chat/spawn-subagents-card.tsx": "subagent action",
  "src/components/chat/tool-approval-card.tsx": "approval submission action",
  "src/features/chat/components/chat-title-rename.tsx": "title rename action",
} as const;

test("the turn status owner is the only turn loader or elapsed ticker", async () => {
  const files = [
    ...new Bun.Glob("src/components/chat/**/*.{ts,tsx}").scanSync("."),
    ...new Bun.Glob("src/features/chat/**/*.{ts,tsx}").scanSync("."),
  ];
  expect(files).toContain(OWNER);
  const violations: string[] = [];
  for (const file of files) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) {
      continue;
    }
    const source = await Bun.file(file).text();
    const ownsLiveIndicator =
      source.includes("@stll/ui/loader") ||
      source.includes("use-live-elapsed") ||
      source.includes('status="running"') ||
      source.includes("animate-spin");
    if (
      ownsLiveIndicator &&
      file !== OWNER &&
      !(file in ALLOWED_NON_TURN_LOADERS)
    ) {
      violations.push(file);
    }
  }
  expect(violations).toEqual([]);
  expect(await Bun.file(OWNER).text()).toContain("data-turn-live-status");
});
