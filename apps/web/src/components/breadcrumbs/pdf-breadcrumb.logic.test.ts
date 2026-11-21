import { describe, expect, test } from "bun:test";

import {
  canRenameDocumentCrumb,
  resolveCrumbRenameShortcut,
} from "@/components/breadcrumbs/pdf-breadcrumb.logic";

describe("document crumb rename affordance", () => {
  const renameable = {
    entityId: "entity-1",
    canUpdateEntity: true,
    isLastCrumb: true,
  };

  test("offers a rename on the crumb naming the open document", () => {
    expect(canRenameDocumentCrumb(renameable)).toBe(true);
  });

  test("withholds the rename from a role that cannot update documents", () => {
    expect(
      canRenameDocumentCrumb({ ...renameable, canUpdateEntity: false }),
    ).toBe(false);
  });

  test("withholds the rename while a further crumb follows", () => {
    expect(canRenameDocumentCrumb({ ...renameable, isLastCrumb: false })).toBe(
      false,
    );
  });

  test("withholds the rename when the route names no document", () => {
    expect(canRenameDocumentCrumb({ ...renameable, entityId: "" })).toBe(false);
  });
});

describe("document crumb keyboard shortcut", () => {
  test("Enter and F2 on the focused crumb open the rename field", () => {
    expect(resolveCrumbRenameShortcut("Enter")).toBe("start-rename");
    expect(resolveCrumbRenameShortcut("F2")).toBe("start-rename");
  });

  test("leaves every other key to the crumb, Escape included", () => {
    for (const key of ["Escape", "Tab", " ", "a", "ArrowRight"]) {
      expect(resolveCrumbRenameShortcut(key)).toBe("ignore");
    }
  });
});
