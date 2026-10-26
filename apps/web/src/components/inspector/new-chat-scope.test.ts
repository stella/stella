import { describe, expect, test } from "bun:test";
import path from "node:path";
import * as ts from "typescript6";
import { createStore } from "zustand";
import { immer } from "zustand/middleware/immer";

import { sourceFileIndex } from "@stll/scripts/src/source-file-index";

import { railChatOpenArgs } from "@/components/inspector/inspector-rail-chat.logic";
import type { InspectorTabsStore } from "@/components/inspector/inspector-store-types";
import { createInspectorTabsSlice } from "@/components/inspector/inspector-tabs-slice";
import {
  dockNewChatArgs,
  newChatMatterScope,
} from "@/components/inspector/new-chat-scope";
import { toChatThreadId } from "@/lib/chat-thread-ref";

const MATTER_A = "matter-a";
const MATTER_B = "matter-b";
const THREAD_IN_B = toChatThreadId("thread-in-b");
const NEW_THREAD = toChatThreadId("thread-new");

/** A chat about matter B is open; the user has since navigated to matter A. */
const storeWithChatInMatterB = () => {
  const store = createStore<InspectorTabsStore>()(
    immer((set, get) => createInspectorTabsSlice(set, get)),
  );
  store.getState().openChat({
    id: THREAD_IN_B,
    workspaceId: MATTER_B,
    contextMatterIds: [MATTER_B],
  });
  return store;
};

const newTab = (store: ReturnType<typeof storeWithChatInMatterB>) => {
  const { activeId, tabs } = store.getState();
  expect(activeId).not.toBe(THREAD_IN_B);
  const tab = tabs.find((candidate) => candidate.id === activeId);
  if (tab?.type !== "chat") {
    throw new Error("expected the new chat tab to be active");
  }
  return tab;
};

describe("newChatMatterScope", () => {
  test("scopes to the matter in the URL", () => {
    expect(newChatMatterScope(MATTER_A)).toEqual({
      workspaceId: MATTER_A,
      contextMatterIds: [MATTER_A],
    });
  });

  test("is global off a matter route", () => {
    expect(newChatMatterScope(undefined)).toEqual({});
  });
});

describe("a new chat after navigating from matter B to matter A", () => {
  // The shortcuts, the rail menu and the command palette pass
  // newChatMatterScope(route) straight to openChat; the census below holds
  // them to it.
  test("New chat shortcut, rail menu, command palette", () => {
    const store = storeWithChatInMatterB();
    store.getState().openChat(newChatMatterScope(MATTER_A));
    expect(newTab(store)).toMatchObject({
      workspaceId: MATTER_A,
      contextMatterIds: [MATTER_A],
    });
  });

  test("rail New chat button", () => {
    const store = storeWithChatInMatterB();
    store.getState().openChat(railChatOpenArgs({ workspaceId: MATTER_A }));
    expect(newTab(store)).toMatchObject({
      workspaceId: MATTER_A,
      contextMatterIds: [MATTER_A],
    });
  });

  test("dock New chat, pressed in the tab about matter B", () => {
    const store = storeWithChatInMatterB();
    const tabInB = store
      .getState()
      .tabs.find((candidate) => candidate.id === THREAD_IN_B);
    if (tabInB?.type !== "chat") {
      throw new Error("expected the matter B chat tab");
    }
    store.getState().openChat(
      dockNewChatArgs({
        id: NEW_THREAD,
        routeWorkspaceId: MATTER_A,
        tab: tabInB,
      }),
    );
    expect(newTab(store)).toMatchObject({
      id: NEW_THREAD,
      workspaceId: MATTER_A,
      contextMatterIds: [MATTER_A],
    });
  });

  test("dock New chat off a matter route opens a global chat", () => {
    const store = storeWithChatInMatterB();
    store.getState().openChat(
      dockNewChatArgs({
        id: NEW_THREAD,
        routeWorkspaceId: undefined,
        tab: {},
      }),
    );
    const tab = newTab(store);
    expect(tab.workspaceId).toBeUndefined();
    expect(tab.contextMatterIds).toEqual([]);
  });

  test("dock New chat keeps the tab's document and skill", () => {
    const activeSkill = { skillName: "playbook-builder" };
    expect(
      dockNewChatArgs({
        id: NEW_THREAD,
        routeWorkspaceId: MATTER_A,
        tab: { activeSkill },
      }),
    ).toEqual({
      id: NEW_THREAD,
      activeSkill,
      workspaceId: MATTER_A,
      contextMatterIds: [MATTER_A],
    });
  });
});

// Census: every `openChat` caller either builds a new chat's scope from the
// route (through one of the builders below) or opens a chat whose scope
// belongs to the thing it opens, and says so here. No caller reads a matter
// off an open tab.
const SOURCE_ROOT = path.resolve(import.meta.dirname, "../..");
const ROUTE_SCOPE_BUILDERS = new Set([
  "dockNewChatArgs",
  "newChatMatterScope",
  "railChatOpenArgs",
]);
const SCOPED_BY_WHAT_THEY_OPEN: Record<string, string> = {
  "components/chat/chat-thread-decision.tsx":
    "reopens an existing thread with the scope stored on it",
  "components/chat/use-request-chat-about.ts":
    "asks about rows of the matter that lists them",
  "components/decision-chat-open.logic.ts":
    "a decision's own conversation, no matter",
  "components/inbox/signal-actions.ts": "the signal's own matter",
  "components/legal-reader/annotations/reader-annotation-target.ts":
    "a decision's own conversation, no matter",
  "components/public-law-ask.ts": "a legal document's conversation, no matter",
  "routes/knowledge/-components/skill-editor.tsx":
    "tries a skill from the skill editor, which has no matter",
};

const calleeName = (call: ts.CallExpression): string | undefined => {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  return undefined;
};

type OpenChatCall = {
  argument: ts.Node;
  file: string;
  line: number;
  source: ts.SourceFile;
};

const openChatCalls = (): OpenChatCall[] =>
  sourceFileIndex(SOURCE_ROOT)
    .filter(
      ({ relativePath, sourceText }) =>
        !/\.(test|spec)\.tsx?$/u.test(relativePath) &&
        sourceText.includes("openChat("),
    )
    .flatMap((entry) => {
      const source = entry.sourceFile(false);
      const calls: OpenChatCall[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && calleeName(node) === "openChat") {
          // A bare openChat() opens a global chat wherever the user is, so
          // it has to be listed too: its argument is the empty object.
          calls.push({
            argument:
              node.arguments[0] ?? ts.factory.createObjectLiteralExpression(),
            file: entry.relativePath,
            line:
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1,
            source,
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return calls;
    });

const callsBuilder = (node: ts.Node): boolean =>
  (ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ROUTE_SCOPE_BUILDERS.has(node.expression.text)) ||
  (ts.forEachChild(node, (child) => callsBuilder(child) || undefined) ?? false);

const MATTER_FIELDS = new Set(["contextMatterIds", "workspaceId"]);
const readsTabMatter = (node: ts.Node, source: ts.SourceFile): boolean =>
  (ts.isPropertyAccessExpression(node) &&
    MATTER_FIELDS.has(node.name.text) &&
    /tab/iu.test(node.expression.getText(source))) ||
  (ts.isIdentifier(node) &&
    /^tab(WorkspaceId|ContextMatterIds)$/u.test(node.text)) ||
  (ts.forEachChild(
    node,
    (child) => readsTabMatter(child, source) || undefined,
  ) ??
    false);

describe("openChat census", () => {
  const calls = openChatCalls();

  test("finds the entry points", () => {
    expect(calls.length).toBeGreaterThan(10);
  });

  test("no caller copies an open tab's matter into openChat", () => {
    expect(
      calls
        .filter(({ argument, source }) => readsTabMatter(argument, source))
        .map(({ file, line }) => `${file}:${line}`),
    ).toEqual([]);
  });

  test("every caller scopes from the route or is listed with its reason", () => {
    expect(
      calls
        .filter(
          ({ argument, file }) =>
            !callsBuilder(argument) &&
            SCOPED_BY_WHAT_THEY_OPEN[file] === undefined,
        )
        .map(({ file, line }) => `${file}:${line}`),
    ).toEqual([]);
  });

  test("the listed files still call openChat", () => {
    const callers = new Set(calls.map(({ file }) => file));
    expect(
      Object.keys(SCOPED_BY_WHAT_THEY_OPEN).filter(
        (file) => !callers.has(file),
      ),
    ).toEqual([]);
  });
});
