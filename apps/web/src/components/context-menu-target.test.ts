import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import {
  contextMenuBelongsTo,
  resolveContextMenuTarget,
} from "@/components/context-menu-target";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

afterAll(async () => {
  await unregisterDomEnvironment();
});

test("the nearest nested entity owns a context-menu event", () => {
  const matter = document.createElement("li");
  matter.dataset["entityKind"] = "matter";
  matter.dataset["entityId"] = "matter-1";
  const documentRow = document.createElement("button");
  documentRow.dataset["entityKind"] = "document";
  documentRow.dataset["entityId"] = "document-1";
  const label = document.createElement("span");
  documentRow.append(label);
  matter.append(documentRow);

  expect(resolveContextMenuTarget({ target: label })).toEqual({
    id: "document-1",
    kind: "document",
  });
  expect(
    contextMenuBelongsTo(
      { target: label },
      { id: "document-1", kind: "document" },
    ),
  ).toBe(true);
  expect(
    contextMenuBelongsTo({ target: label }, { id: "matter-1", kind: "matter" }),
  ).toBe(false);
});

test("task rows resolve independently from their matter", () => {
  const task = document.createElement("button");
  task.dataset["entityKind"] = "task";
  task.dataset["entityId"] = "task-1";

  expect(resolveContextMenuTarget({ target: task })).toEqual({
    id: "task-1",
    kind: "task",
  });
});
