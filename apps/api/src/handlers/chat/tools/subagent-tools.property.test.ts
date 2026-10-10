import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  createSubagentProposalBuffer,
  projectToolMapForSubagent,
} from "@/api/handlers/chat/tools/subagent-tools";
import {
  applyChatToolPolicy,
  CHAT_TOOL_POLICY_KIND,
} from "@/api/handlers/chat/tools/tool-policy";
import type { ChatTool } from "@/api/lib/chat/chat-tool-types";
import { ownJsonKey, ownKeyJsonObject } from "@/api/tests/helpers/own-key-json";

test("subagent tool projection retains every eligible own entry and its input", async () => {
  await assertProperty(
    "subagent tool projection retains every eligible own entry and its input",
    fc.asyncProperty(
      fc.uniqueArray(ownJsonKey, { maxLength: 8 }),
      ownKeyJsonObject({ nulls: true }),
      fc.constantFrom(
        CHAT_TOOL_POLICY_KIND.internal,
        CHAT_TOOL_POLICY_KIND.mutation,
      ),
      async (keys, input, policyKind) => {
        const names = [...new Set([...keys, "__proto__", "constructor"])];
        const calls: { toolName: string; args: unknown }[] = [];
        const tools = Object.fromEntries(
          names.map((name) => {
            const tool = {
              name,
              description: "Fixture tool",
              execute: (args: unknown) => {
                calls.push({ toolName: name, args });
                return "complete";
              },
            } satisfies ChatTool;
            return [name, applyChatToolPolicy(tool, policyKind)];
          }),
        );
        const buffer = createSubagentProposalBuffer();
        const projected = projectToolMapForSubagent(tools, buffer.sink);
        expect(Object.keys(projected).toSorted()).toEqual(names.toSorted());
        const args = Object.fromEntries([
          ...Object.entries(input),
          ["__proto__", input],
          ["constructor", input],
        ]);
        const originalArgs = structuredClone(args);
        for (const name of names) {
          expect(Object.hasOwn(projected, name)).toBe(true);
          expect(projected[name]?.name).toBe(name);
          await projected[name]?.execute?.(args, undefined);
        }
        expect(args).toEqual(originalArgs);
        expect(Object.hasOwn(args, "__proto__")).toBe(true);
        expect(Object.hasOwn(args, "constructor")).toBe(true);
        const expected = names.map((toolName) => ({
          toolName,
          args: originalArgs,
        }));
        expect(calls).toEqual(
          policyKind === CHAT_TOOL_POLICY_KIND.internal ? expected : [],
        );
        expect(buffer.list()).toEqual(
          policyKind === CHAT_TOOL_POLICY_KIND.mutation ? expected : [],
        );
      },
    ),
  );
});
