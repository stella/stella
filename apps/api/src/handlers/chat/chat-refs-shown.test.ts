import { describe, expect, test } from "bun:test";

import { chatRefsWrittenIn } from "@/api/handlers/chat/chat-refs-shown";
import { ASK_USER_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";
import type { ChatPart } from "@/api/handlers/chat/types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import {
  brandPersistedEntityId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

const SERVER_TOOL = "execute_typescript";

describe("the parts of an assistant message that may hold shown refs", () => {
  test("are what the model wrote and a server tool's output, never an answer a user wrote", () => {
    const text = { content: "Two documents", type: "text" } satisfies ChatPart;
    const script = {
      typescriptCode: 'return external_read_document({ entity_id: "ent_1" })',
    };
    const listed = { logs: [], result: { id: "ent_1" }, success: true };
    const parts = [
      text,
      {
        arguments: JSON.stringify(script),
        id: "call-1",
        input: script,
        name: SERVER_TOOL,
        output: listed,
        state: "complete",
        type: "tool-call",
      },
      {
        arguments: "{}",
        id: "call-2",
        input: {},
        name: ASK_USER_TOOL_NAME,
        output: { answers: [{ answer: "ent_7", question: "Which?" }] },
        state: "complete",
        type: "tool-call",
      },
      {
        content: JSON.stringify({ answers: [{ answer: "ent_7" }] }),
        state: "complete",
        toolCallId: "call-2",
        type: "tool-result",
      },
    ] satisfies ChatPart[];

    expect(
      chatRefsWrittenIn({
        isServerTool: (name) => name === SERVER_TOOL,
        parts,
      }),
    ).toEqual({ values: [text, script, listed, {}] });
  });

  test("a ref the prompt showed, used only in a script's input, is bound", () => {
    // The active file's ref, as the system prompt shows it.
    const registry = createChatRefRegistry();
    const activeFile = {
      entityId: brandPersistedEntityId("01a0df7d-c93a-7105-99f9-c66cf1b14d0a"),
      workspaceId: brandPersistedWorkspaceId(
        "01a0df7d-c93a-7105-99f9-c66cf1b14d01",
      ),
    };
    const ref = registry.toEntityRef(activeFile);
    const script = {
      typescriptCode: `const d = await external_read_content_across_matters({ entity_id: "${ref}" }); return d.text.length;`,
    };
    const parts = [
      {
        arguments: JSON.stringify(script),
        id: "call-1",
        input: script,
        name: SERVER_TOOL,
        output: { logs: [], result: 1200, success: true },
        state: "complete",
        type: "tool-call",
      },
    ] satisfies ChatPart[];

    const bindings = registry.collectRefBindings(
      chatRefsWrittenIn({ isServerTool: () => true, parts }),
    );

    expect(bindings).toEqual([
      {
        entity: { id: activeFile.entityId, type: "entity" },
        kind: "entity",
        ref,
        workspace: { id: activeFile.workspaceId, type: "workspace" },
      },
    ]);
  });
});
