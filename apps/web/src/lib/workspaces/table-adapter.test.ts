import { describe, expect, test } from "bun:test";

import type { WorkspaceTableAdapter } from "@/lib/workspaces/table-adapter";
import { workspaceTableAdapter } from "@/lib/workspaces/table-adapter";

describe("workspaceTableAdapter", () => {
  // Total over the adapter's own keys, so a fifth row source cannot be added
  // without being named here: `satisfies` fails to compile until it is.
  const COVERED = {
    useListPage: true,
    useSectionPage: true,
    sectionCounts: true,
    detail: true,
  } as const satisfies Record<keyof WorkspaceTableAdapter, true>;

  test("the table reads rows through exactly these entry points", () => {
    expect(Object.keys(workspaceTableAdapter).toSorted()).toEqual(
      Object.keys(COVERED).toSorted(),
    );
  });

  test("every entry point is a factory the caller invokes itself", () => {
    for (const entry of Object.values(workspaceTableAdapter)) {
      expect(typeof entry).toBe("function");
    }
  });
});
