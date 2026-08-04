import { expect, test } from "bun:test";

import type { ChatAnonPair } from "@stll/anonymize-chat";

import { createChatAnonDecorationOwner } from "./chat-anon-decoration-owner";

type TestEditor = { view: object };

const mainPairs = [
  { label: "person", original: "Jan Novák", placeholder: "[PERSON_1]" },
] as const satisfies readonly ChatAnonPair[];
const inspectorPairs = [
  { label: "person", original: "Eva Nováková", placeholder: "[PERSON_1]" },
] as const satisfies readonly ChatAnonPair[];

test("only the focused chat surface can own shared-editor anonymization decorations", async () => {
  const writes: (readonly unknown[])[] = [];
  const owner = createChatAnonDecorationOwner<TestEditor>((_editor, pairs) => {
    writes.push(pairs);
  });
  const editor = { view: {} };

  // Two surfaces are mounted against one editor. The main chat's DOM focus
  // callback fires; the inspector merely receives a later worker result.
  owner.setActive({ editor, ownerKey: "main", pairs: mainPairs });
  owner.updateActive({ editor, ownerKey: "inspector", pairs: inspectorPairs });

  expect(writes).toEqual([mainPairs]);

  // This is an architectural guard, not a framework-private assertion: the
  // ownership signal must come from the focused surface. Subscribing every
  // mounted layer to the shared editor's focus event reintroduces the bug.
  const source = await Bun.file(
    new URL("use-chat-anonymization-layer.ts", import.meta.url),
  ).text();
  expect(source).toContain("focused,");
  expect(source).not.toMatch(/editor\.on\(\s*["']focus/u);
});
