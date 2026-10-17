import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { inspectorStateEntry } from "@/components/inspector/inspector-storage-keys";
import { browserStorage, deviceStorage } from "@/lib/account/browser-storage";
import { userStorageKey } from "@/lib/account/user-scoped-storage";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import {
  definePersistedState,
  isRestoredStateSafeMode,
  keepInAnyScope,
  readPersistedState,
  writePersistedState,
} from "./registry";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

const storage = deviceStorage("local");
const key = "stella:inspector-pane-width:registry-test";
const entry = definePersistedState({
  key,
  area: "local",
  version: 2,
  schema: v.object({ width: v.number() }),
  maxBytes: 128,
  defaultValue: () => ({ width: 512 }),
  scopeCheck: keepInAnyScope,
  restoredUi: true,
});

const ownedKey = "stella:inspector-pane-width:registry-test-owned";
const ownedEntry = definePersistedState({
  key: ownedKey,
  area: "local",
  version: 1,
  schema: v.nullable(v.object({ workspaceId: v.string() })),
  maxBytes: 128,
  defaultValue: () => null,
  scopeCheck: (value, scope: { workspaceId: string }) =>
    value === null || value.workspaceId === scope.workspaceId
      ? keepInAnyScope(value)
      : { keep: false },
  restoredUi: false,
});

beforeEach(() => {
  storage.removeItem(key);
  storage.removeItem(ownedKey);
  globalThis.history.replaceState(null, "", "/workspaces");
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

describe("persisted state registry", () => {
  test("round trips a valid current-version value", () => {
    expect(writePersistedState(entry, {}, { width: 640 }).isOk()).toBe(true);
    expect(readPersistedState(entry, {})).toEqual({ width: 640 });
  });

  test.each([
    ["invalid JSON", "{"],
    [
      "the wrong schema",
      JSON.stringify({ version: 2, value: { width: "wide" } }),
    ],
    ["an old version", JSON.stringify({ version: 1, value: { width: 640 } })],
  ])("removes %s", (_name, raw) => {
    storage.setItem(key, raw);
    expect(readPersistedState(entry, {})).toEqual({ width: 512 });
    expect(storage.getItem(key)).toBeNull();
  });

  test("a scope check rejects a valid non-null value from another scope", () => {
    storage.setItem(
      ownedKey,
      JSON.stringify({ version: 1, value: { workspaceId: "other" } }),
    );
    expect(readPersistedState(ownedEntry, { workspaceId: "me" })).toBeNull();
    expect(storage.getItem(ownedKey)).toBeNull();
  });

  test("a scope check keeps a stored null and the reader's own value", () => {
    storage.setItem(ownedKey, JSON.stringify({ version: 1, value: null }));
    expect(readPersistedState(ownedEntry, { workspaceId: "me" })).toBeNull();
    expect(storage.getItem(ownedKey)).not.toBeNull();

    storage.setItem(
      ownedKey,
      JSON.stringify({ version: 1, value: { workspaceId: "me" } }),
    );
    expect(readPersistedState(ownedEntry, { workspaceId: "me" })).toEqual({
      workspaceId: "me",
    });
  });

  test("removes an oversized value", () => {
    storage.setItem(
      key,
      JSON.stringify({
        version: 2,
        value: { width: 640 },
        padding: "x".repeat(200),
      }),
    );
    expect(readPersistedState(entry, {})).toEqual({ width: 512 });
    expect(storage.getItem(key)).toBeNull();
  });

  test("blocked storage reads as the default and writes as an error value", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: Object.defineProperty({}, "localStorage", {
        get: () => {
          throw new Error("blocked");
        },
      }),
    });
    expect(readPersistedState(entry, {})).toEqual({ width: 512 });
    expect(writePersistedState(entry, {}, { width: 640 }).isErr()).toBe(true);
    if (descriptor !== undefined) {
      Object.defineProperty(globalThis, "window", descriptor);
    }
  });

  test("safe mode defaults restored UI", () => {
    writePersistedState(entry, {}, { width: 640 });
    globalThis.history.replaceState(null, "", "/workspaces?safe=1");
    expect(isRestoredStateSafeMode()).toBe(true);
    expect(readPersistedState(entry, {})).toEqual({ width: 512 });
  });

  test("keeps a docx tab with no PDF and drops a task from another workspace", () => {
    const scope = {
      userId: "user-1",
      organizationId: "org-1",
      workspaceId: "workspace-1",
    };
    const docx = {
      id: "docx-1",
      type: "file",
      label: "Pleading.docx",
      fileName: "Pleading.docx",
      entityId: "file-1",
      workspaceId: "workspace-1",
      pdfFileId: null,
    };
    const foreignTask = {
      id: "task-1",
      type: "task",
      label: "Foreign task",
      workspaceId: "workspace-2",
    };
    writePersistedState(inspectorStateEntry, scope, {
      tabs: [docx, foreignTask],
      groups: [],
      groupAssignments: {},
      activeId: "docx-1",
      collapsedGroupIds: [],
    });

    expect(readPersistedState(inspectorStateEntry, scope)?.tabs).toEqual([
      docx,
    ]);
    const rawStorage = browserStorage("local");
    expect(
      rawStorage?.getItem(
        userStorageKey("stella:inspector-state:v1:org-1:", {
          kind: "user",
          userId: "user-1",
        }),
      ),
    ).not.toBeNull();
  });
});
