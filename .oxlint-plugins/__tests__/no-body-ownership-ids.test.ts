import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (lines: readonly string[]) =>
  await lintSingleRule("no-body-ownership-ids", [...lines, ""].join("\n"), {
    sourcePath: "apps/api/src/handlers/chat/example.ts",
  });

const RESOLVER_IMPORT =
  'import { resolveChatScope } from "@/api/handlers/chat/chat-scope";';

describe.serial("no-body-ownership-ids resolver sink", () => {
  test("accepts the requested id passed straight to resolveChatScope", async () => {
    expect(
      await lint([
        RESOLVER_IMPORT,
        "export const scope = resolveChatScope({ getWorkspaceAccess, workspaceId: body.workspaceId });",
      ]),
    ).toEqual([]);
  });

  test("still reports a direct use of the same id", async () => {
    expect(
      await lint([
        RESOLVER_IMPORT,
        "export const scope = resolveChatScope({ getWorkspaceAccess, workspaceId: body.workspaceId });",
        "export const rows = store.find({ workspaceId: body.workspaceId });",
      ]),
    ).toEqual([3]);
  });

  test("does not treat a same-named local function as the resolver", async () => {
    expect(
      await lint([
        "const resolveChatScope = (options: unknown) => options;",
        "export const scope = resolveChatScope({ workspaceId: body.workspaceId });",
      ]),
    ).toEqual([2]);
  });

  test("does not accept the id under another property of the resolver call", async () => {
    expect(
      await lint([
        RESOLVER_IMPORT,
        "export const scope = resolveChatScope({ getWorkspaceAccess, other: body.workspaceId });",
      ]),
    ).toEqual([2]);
  });
});
