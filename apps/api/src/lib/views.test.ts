import { describe, expect, test } from "bun:test";

import { getDefaultViews } from "@/api/lib/views";

describe("getDefaultViews", () => {
  test("pins requested file columns in the default table view", () => {
    const views = getDefaultViews("en", {
      tableColumnPinning: ["property-file"],
    });

    const tableView = views.find((view) => view.layout.type === "table");

    expect(tableView?.layout).toMatchObject({
      type: "table",
      columnPinning: ["property-file"],
    });
  });

  test("returns cloned table pinning arrays", () => {
    const pinned = ["property-file"];
    const views = getDefaultViews("en", { tableColumnPinning: pinned });
    pinned.push("property-status");

    const tableView = views.find((view) => view.layout.type === "table");

    expect(tableView?.layout).toMatchObject({
      type: "table",
      columnPinning: ["property-file"],
    });
  });
});
