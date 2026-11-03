import { describe, expect, test } from "bun:test";

import type { MatterSummary } from "./matters";
import { groupByClient } from "./matters-groups";

const matter = (id: string, client?: string): MatterSummary => ({
  id,
  name: `Matter ${id}`,
  ...(client === undefined ? {} : { client: { displayName: client } }),
});

describe("matters by client", () => {
  test("puts the matters without a client first, then clients by name", () => {
    const groups = groupByClient(
      [
        matter("1", "Zeta s.r.o."),
        matter("2"),
        matter("3", "Alfa a.s."),
        matter("4", "Zeta s.r.o."),
        matter("5"),
      ],
      "en",
    );
    expect(
      groups.map((group) => [group.client, group.data.map(({ id }) => id)]),
    ).toEqual([
      [null, ["2", "5"]],
      ["Alfa a.s.", ["3"]],
      ["Zeta s.r.o.", ["1", "4"]],
    ]);
  });

  test("orders clients as the locale does", () => {
    const groups = groupByClient(
      [matter("1", "Čedok"), matter("2", "Dvořák"), matter("3", "Cibulka")],
      "cs",
    );
    expect(groups.map((group) => group.client)).toEqual([
      "Cibulka",
      "Čedok",
      "Dvořák",
    ]);
  });

  test("leaves out the personal section when every matter has a client", () => {
    expect(groupByClient([matter("1", "Alfa")], "en")).toEqual([
      { client: "Alfa", data: [matter("1", "Alfa")], key: "client:Alfa" },
    ]);
  });
});
