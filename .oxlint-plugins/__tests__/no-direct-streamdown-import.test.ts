import { describe, expect, test } from "bun:test";

import { restrictedImportMeta } from "../restricted-import.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (lines: readonly string[], sourcePath: string) =>
  await lintSingleRule(
    "no-direct-streamdown-import",
    [...lines, ""].join("\n"),
    { sourcePath },
  );

describe.serial("no-direct-streamdown-import", () => {
  test("reports every way a module reaches streamdown or its plugins", async () => {
    expect(
      await lint(
        [
          'import { Streamdown } from "streamdown";',
          'import type { Components } from "streamdown";',
          'import { cjk } from "@streamdown/cjk";',
          'export { defaultComponents } from "streamdown";',
          'export const pending = import("streamdown");',
          "export const parts: Components = { Streamdown, cjk };",
        ],
        "apps/web/src/components/chat/ask-user-card.tsx",
      ),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  test("names the owner in its message", () => {
    expect(
      Object.values(
        restrictedImportMeta("no-direct-streamdown-import").messages,
      ),
    ).toEqual([
      expect.stringContaining(
        "render untrusted chat content through MessageResponse from @/components/ai-elements/message-response",
      ),
    ]);
  });

  test("accepts the answer renderer's own exports", async () => {
    expect(
      await lint(
        [
          'import { MessageTable } from "@/components/ai-elements/message-response";',
          'import { MessageResponse } from "@/components/ai-elements/message";',
          "export { MessageResponse, MessageTable };",
        ],
        "apps/web/src/components/chat/chat-table-chart.tsx",
      ),
    ).toEqual([]);
  });

  test("lets the answer renderer itself import streamdown", async () => {
    expect(
      await lint(
        [
          'import { defaultRehypePlugins, Streamdown } from "streamdown";',
          'import type { Components } from "streamdown";',
          'import { math } from "@streamdown/math";',
          "export const parts: Components = { defaultRehypePlugins, Streamdown, math };",
        ],
        "apps/web/src/components/ai-elements/message-response.tsx",
      ),
    ).toEqual([]);
  });
});
