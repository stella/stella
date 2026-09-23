import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  createToolReadScopeRecorder,
  recordToolReadScope,
} from "@/api/handlers/chat/tool-read-scope";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  applyChatToolPolicy,
  CHAT_TOOL_POLICY_KIND,
  getChatToolPolicy,
} from "@/api/handlers/chat/tools/tool-policy";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";

const workspaceA = toSafeId<"workspace">(
  "0dc54d0c-10d7-501d-897e-e801dbd0998c",
);
const workspaceB = toSafeId<"workspace">(
  "4e919658-a448-5354-8e3a-e99911214d2c",
);
const workspaceC = toSafeId<"workspace">(
  "c09ec856-d945-5ecc-82e3-bb5382165f34",
);

const setup = (accessible: readonly SafeId<"workspace">[]) => {
  const refRegistry = createChatRefRegistry();
  const persisted: SafeId<"workspace">[][] = [];
  const recorder = createToolReadScopeRecorder({
    accessibleWorkspaceIds: new Set(accessible),
    persist: async (workspaceIds) => {
      persisted.push([...workspaceIds]);
      return Result.ok(undefined);
    },
    refRegistry,
  });
  return { persisted, recorder, refRegistry };
};

describe("tool read scope", () => {
  test("records reads observed after the turn starts, once each", async () => {
    const { persisted, recorder, refRegistry } = setup([
      workspaceA,
      workspaceB,
    ]);
    refRegistry.toMatterRef(workspaceA);
    recorder.startTurn();

    refRegistry.offerMatterRef(workspaceB);
    await recorder.recordObservedReads();
    expect(persisted).toEqual([]);

    refRegistry.toMatterRef(workspaceB);
    await recorder.recordObservedReads();
    await recorder.recordObservedReads();
    expect(persisted).toEqual([[workspaceB]]);
  });

  test("records nothing before the turn starts", async () => {
    const { persisted, recorder, refRegistry } = setup([workspaceA]);
    refRegistry.toMatterRef(workspaceA);

    await recorder.recordObservedReads();

    expect(persisted).toEqual([]);
  });

  test("never records a workspace outside the accessible set", async () => {
    const { persisted, recorder, refRegistry } = setup([workspaceA]);
    recorder.startTurn();

    refRegistry.toMatterRef(workspaceC);
    await recorder.recordObservedReads();

    expect(persisted).toEqual([]);
  });

  test("a tool's reads are recorded before its result is returned", async () => {
    const { persisted, recorder, refRegistry } = setup([workspaceA]);
    const read = toolDefinition({
      name: "read-matter",
      description: "Read a matter.",
      inputSchema: toTanStackToolSchema(v.strictObject({})),
    }).server(() => ({ matterRef: refRegistry.toMatterRef(workspaceA) }));
    applyChatToolPolicy(read, CHAT_TOOL_POLICY_KIND.internal);
    const tools = recordToolReadScope({ recorder, tools: { read } });
    recorder.startTurn();

    const output: unknown = await tools["read"]?.execute?.({}, undefined);

    expect(output).toEqual({ matterRef: refRegistry.toMatterRef(workspaceA) });
    expect(persisted).toEqual([[workspaceA]]);
    const wrapped = tools["read"];
    if (wrapped === undefined) {
      throw new TypeError("Expected the wrapped tool");
    }
    expect(getChatToolPolicy(wrapped).kind).toBe(
      CHAT_TOOL_POLICY_KIND.internal,
    );
  });

  test("a failed scope write fails the tool call", async () => {
    const refRegistry = createChatRefRegistry();
    const recorder = createToolReadScopeRecorder({
      accessibleWorkspaceIds: new Set([workspaceA]),
      persist: async () => Result.err(new Error("scope write failed")),
      refRegistry,
    });
    const read = toolDefinition({
      name: "read-matter",
      description: "Read a matter.",
      inputSchema: toTanStackToolSchema(v.strictObject({})),
    }).server(() => ({ matterRef: refRegistry.toMatterRef(workspaceA) }));
    applyChatToolPolicy(read, CHAT_TOOL_POLICY_KIND.internal);
    const tools = recordToolReadScope({ recorder, tools: { read } });
    recorder.startTurn();

    await expect(tools["read"]?.execute?.({}, undefined)).rejects.toThrow(
      "Failed to record the thread's data scope.",
    );
  });

  test("a mutation keeps its committed result when the scope write fails", async () => {
    const refRegistry = createChatRefRegistry();
    const recorder = createToolReadScopeRecorder({
      accessibleWorkspaceIds: new Set([workspaceA]),
      persist: async () => Result.err(new Error("scope write failed")),
      refRegistry,
    });
    const save = toolDefinition({
      name: "save-document",
      description: "Save a document.",
      inputSchema: toTanStackToolSchema(v.strictObject({})),
    }).server(() => ({ matterRef: refRegistry.toMatterRef(workspaceA) }));
    applyChatToolPolicy(save, CHAT_TOOL_POLICY_KIND.mutation);
    const tools = recordToolReadScope({ recorder, tools: { save } });
    recorder.startTurn();

    const output: unknown = await tools["save"]?.execute?.({}, undefined);

    expect(output).toEqual({ matterRef: refRegistry.toMatterRef(workspaceA) });
  });
});
