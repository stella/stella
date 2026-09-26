import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  createBundleGraph,
  US_CITATION_BUNDLE_LIMIT,
} from "@/api/handlers/case-law/ingestion/us-citation-bundles";
import type { ReporterBase } from "@/api/handlers/case-law/ingestion/us-citation-scanner";

/** A base in its own reporter family, so any number of them may be parallel. */
const baseIn = (family: number, page = 1): ReporterBase => {
  const value = `${String(page)} R${String(family)}. 1`;
  return {
    volume: String(page),
    edition: `R${String(family)}.`,
    identifier: { type: "reporter-citation", value },
    key: value,
    family: `R${String(family)}`,
  };
};

const openWith = (count: number) => {
  const graph = createBundleGraph();
  const opened = graph.open(baseIn(0), null);
  if (Result.isError(opened)) {
    throw opened.error;
  }
  const joined = Array.from({ length: count - 1 }, (_, index) =>
    graph.join(opened.value, baseIn(index + 1)),
  );
  return { graph, bundle: opened.value, joined };
};

describe("the identity bound", () => {
  test("admits exactly the limit", () => {
    const { bundle, graph, joined } = openWith(US_CITATION_BUNDLE_LIMIT);
    expect(joined.every(Result.isOk)).toBe(true);
    const target = graph.target(bundle);
    expect(target.status === "identified" ? target.bases.length : 0).toBe(
      US_CITATION_BUNDLE_LIMIT,
    );
  });

  test("rejects the identifier past it while merging", () => {
    const { joined } = openWith(US_CITATION_BUNDLE_LIMIT + 1);
    const last = joined.at(-1);
    expect(
      last !== undefined && Result.isError(last) ? last.error._tag : "accepted",
    ).toBe("UsCitationBundleOverflowError");
  });

  test("rejects two entities whose union would pass it", () => {
    const graph = createBundleGraph();
    const left = graph.open(baseIn(0), null);
    const right = graph.open(baseIn(100), null);
    if (Result.isError(left) || Result.isError(right)) {
      throw new TypeError("Opening a bundle failed");
    }
    for (let family = 1; family < 16; family += 1) {
      graph.join(left.value, baseIn(family));
      graph.join(right.value, baseIn(100 + family));
    }
    // A third bundle printing one identifier of each links them: 33 in all.
    const bridge = graph.open(baseIn(0), null);
    if (Result.isError(bridge)) {
      throw bridge.error;
    }
    graph.join(bridge.value, baseIn(200));
    const linked = graph.join(bridge.value, baseIn(100));
    expect(Result.isError(linked) ? linked.error._tag : "accepted").toBe(
      "UsCitationBundleOverflowError",
    );
  });
});

describe("entities", () => {
  test("a repeated identifier is one entity, held once", () => {
    const graph = createBundleGraph();
    const first = graph.open(baseIn(1), "brown v board").unwrap();
    const again = graph.open(baseIn(1), "brown v board").unwrap();
    expect(graph.root(again)).toBe(graph.root(first));
    expect(graph.target(again)).toEqual({
      status: "identified",
      bases: [baseIn(1)],
    });
  });

  test("two first pages of one reporter conflict", () => {
    const graph = createBundleGraph();
    const first = graph.open(baseIn(1, 483), null).unwrap();
    graph.join(first, baseIn(2)).unwrap();
    const second = graph.open(baseIn(2), null).unwrap();
    graph.join(second, baseIn(1, 497)).unwrap();
    expect(graph.target(first)).toEqual({ status: "conflicting" });
  });

  test("two different captions conflict, whatever parties they share", () => {
    const graph = createBundleGraph();
    const first = graph.open(baseIn(1), "united states v jones").unwrap();
    graph.open(baseIn(1), "united states v smith").unwrap();
    expect(graph.target(first)).toEqual({ status: "conflicting" });
  });

  test("identifiers are stored U.S., S. Ct., L. Ed., then by spelling", () => {
    const graph = createBundleGraph();
    const base = (edition: string, family: string): ReporterBase => ({
      volume: "1",
      edition,
      identifier: { type: "reporter-citation", value: `1 ${edition} 1` },
      key: `1 ${edition} 1`,
      family,
    });
    const bundle = graph.open(base("L. Ed.", "Lawyer"), null).unwrap();
    graph.join(bundle, base("A.2d", "Atlantic")).unwrap();
    graph.join(bundle, base("S. Ct.", "West")).unwrap();
    graph.join(bundle, base("U.S.", "United States")).unwrap();
    const target = graph.target(bundle);
    expect(
      target.status === "identified"
        ? target.bases.map(({ edition }) => edition)
        : [],
    ).toEqual(["U.S.", "S. Ct.", "L. Ed.", "A.2d"]);
  });
});
