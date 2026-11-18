import { describe, expect, test } from "bun:test";
import path from "node:path";

import { type Node, parseSource, walk } from "@stll/scripts/src/syntax-tree";

const apiRoot = path.resolve(import.meta.dir, "../../..");

/**
 * Every place outside tests and fixtures that inserts a chat thread row, by
 * what the row holds when its first message is sent:
 *
 * - `first_send`: the send itself creates the row; the fields its first
 *   message decides come from `resolveSendThreadFields`.
 * - `before_first_message`: the row is stored without messages before the
 *   first send (a setting chosen in a new chat's composer, an empty chat a
 *   surface opens). The send that writes the first message adopts such a row
 *   through the same `resolveSendThreadFields`, so the row only needs the
 *   owner, scope and the setting it stores.
 * - `with_history`: the row is created together with its messages in one
 *   transaction, so no send ever finds it empty.
 *
 * A new insert must be classified here. A row stored empty that a send must
 * not adopt as its first message needs its own decision in
 * `send-message-thread.ts` before it can be listed.
 */
const CHAT_THREAD_INSERTS = {
  "src/handlers/chat/send-message-thread.ts#0": "first_send",
  "src/handlers/chat/update-thread-model.ts#0": "before_first_message",
  "src/handlers/chat/threads/update.ts#0": "before_first_message",
  "src/handlers/chat/file-thread-shared.ts#0": "before_first_message",
  "src/handlers/chat/template-thread-shared.ts#0": "before_first_message",
  "src/handlers/chat/fork/create.ts#0": "with_history",
  "src/handlers/search/ai.ts#0": "with_history",
} as const satisfies Record<
  string,
  "first_send" | "before_first_message" | "with_history"
>;

const isInsertInto = (node: Node, table: string): boolean =>
  node.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  !node.callee.computed &&
  node.callee.property.type === "Identifier" &&
  node.callee.property.name === "insert" &&
  node.arguments.some(
    (argument) =>
      (argument.type === "Identifier" && argument.name === table) ||
      (argument.type === "MemberExpression" &&
        !argument.computed &&
        argument.property.type === "Identifier" &&
        argument.property.name === table),
  );

const insertCount = (file: string, source: string, table: string): number => {
  let count = 0;
  walk(parseSource(file, source).program, (node) => {
    if (isInsertInto(node, table)) {
      count += 1;
    }
  });
  return count;
};

const readSources = async () => {
  const files = [
    ...new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: apiRoot }),
  ].filter(
    (file) =>
      !file.startsWith("src/tests/") &&
      !/\.(test|spec)\.tsx?$/u.test(file) &&
      !file.endsWith(".d.ts"),
  );
  return await Promise.all(
    files.map(async (file) => ({
      file,
      source: await Bun.file(path.join(apiRoot, file)).text(),
    })),
  );
};

describe("chat thread rows created outside a send", () => {
  test("every chat thread insert is classified by what its first send finds", async () => {
    const sources = await readSources();
    const found = sources
      .filter(({ source }) => source.includes("chatThreads"))
      .flatMap(({ file, source }) =>
        Array.from(
          { length: insertCount(file, source, "chatThreads") },
          (_, index) => `${file}#${String(index)}`,
        ),
      )
      .toSorted();

    expect(found).toEqual(Object.keys(CHAT_THREAD_INSERTS).toSorted());
  });

  test("a row classified as created with its history inserts messages alongside", async () => {
    const sources = new Map(
      (await readSources()).map(({ file, source }) => [file, source]),
    );
    const withHistoryFiles = Object.entries(CHAT_THREAD_INSERTS)
      .filter(([, kind]) => kind === "with_history")
      .map(([site]) => site.slice(0, site.lastIndexOf("#")));

    expect(withHistoryFiles.length).toBeGreaterThan(0);
    const insertsMessages = withHistoryFiles.map((file) => ({
      file,
      insertsMessages:
        insertCount(file, sources.get(file) ?? "", "chatMessages") > 0,
    }));
    expect(insertsMessages).toEqual(
      withHistoryFiles.map((file) => ({ file, insertsMessages: true })),
    );
  });
});
