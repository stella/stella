import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { serializeToolResult } from "@/api/mcp/tool-utils";
import { handleMcpToolCall } from "@/api/mcp/tools";

import { READABLE_DOCUMENTS } from "./playbook-builder-scenarios";
import { createPlaybookStore } from "./playbook-store";

/**
 * The store exists so the production handlers run unmodified. These pin the
 * one read it answers from the fixtures rather than from its own rows: the
 * scoped document lookup behind a position's `sources`.
 */

const call = async (
  store: ReturnType<typeof createPlaybookStore>,
  toolName: "save_playbook" | "list_playbooks",
  args: Record<string, unknown>,
): Promise<unknown> => {
  const result: ReturnType<typeof serializeToolResult> =
    await handleMcpToolCall({ args, context: store.context, toolName });
  const text = result.content.at(0);
  return text?.type === "text" ? JSON.parse(text.text) : null;
};

const position = (issue: string, sources: string[]) => ({
  mode: "extract",
  issue,
  ask: { question: `What is the ${issue}?` },
  sources,
});

const [readable] = READABLE_DOCUMENTS;
if (readable === undefined) {
  panic("the fixtures hold at least one readable document");
}
const UNKNOWN_DOCUMENT_ID = "9a0c1e2f-3b4d-4c5e-8f6a-7b8c9d0e1f99";

describe("the eval's playbook store", () => {
  test("a save cites a fixture document under its own matter and refuses a document no fixture holds", async () => {
    const store = createPlaybookStore([], READABLE_DOCUMENTS);

    const saved = await call(store, "save_playbook", {
      name: "IT services",
      positions: [
        position("term", [readable.entityId]),
        position("notice period", [UNKNOWN_DOCUMENT_ID]),
      ],
    });

    expect(saved).toMatchObject({
      positionCount: 1,
      issues: [{ code: "unreadable_source", path: "positions.1.sources.0" }],
    });
    expect(store.playbooks().at(0)?.positions.items.at(0)?.sources).toEqual([
      { workspaceId: readable.workspaceId, entityId: readable.entityId },
    ]);
  });

  test("a later save keeps the stored sources, and a read returns them", async () => {
    const store = createPlaybookStore([], READABLE_DOCUMENTS);
    const created = v.parse(
      v.object({ playbookId: v.string(), updatedAt: v.string() }),
      await call(store, "save_playbook", {
        name: "IT services",
        positions: [position("term", [readable.entityId])],
      }),
    );

    await call(store, "save_playbook", {
      playbook_id: created.playbookId,
      expected_updated_at: created.updatedAt,
      positions: [position("notice period", [])],
    });

    expect(
      await call(store, "list_playbooks", { playbook_id: created.playbookId }),
    ).toMatchObject({
      playbook: {
        positions: {
          items: [
            {
              issue: "term",
              sources: [
                {
                  workspaceId: readable.workspaceId,
                  entityId: readable.entityId,
                },
              ],
            },
            { issue: "notice period" },
          ],
        },
      },
    });
  });

  test("with no readable document, every source is refused", async () => {
    const store = createPlaybookStore([], []);

    expect(
      await call(store, "save_playbook", {
        name: "IT services",
        positions: [position("term", [readable.entityId])],
      }),
    ).toMatchObject({ error: { code: "validation_error" } });
    expect(store.playbooks()).toEqual([]);
  });
});
