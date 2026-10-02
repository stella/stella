import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { createHash } from "node:crypto";
import * as v from "valibot";

import type { ProvisionNode, StatuteAst } from "@stll/legal-ast/statute-ast";
import { assertProperty } from "@stll/property-testing";

import { parseAmendmentInstruction } from "./amendment-instruction";
import { formatExplanatoryReferences } from "./explanatory-report-heading";
import { resolveExplanatoryBlocks } from "./explanatory-report-resolver";
import type { PendingExplanatoryBlock } from "./explanatory-report-resolver";
import { PROVISION_CITATION_GRAMMARS } from "./provision-citation-grammars";

const root = new URL("__fixtures__/explanatory-reports/", import.meta.url);
const readCapture = async (name: string) => {
  const bytes = await Bun.file(new URL(name, root)).bytes();
  const provenance = v.parse(
    v.object({
      capture: v.literal("recorded"),
      sha256: v.string(),
      sourceUrl: v.string(),
      encoding: v.literal("gzip"),
    }),
    await Bun.file(new URL(`${name}.provenance.json`, root)).json(),
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    provenance.sha256,
  );
  const value: unknown = JSON.parse(
    new TextDecoder().decode(Bun.gunzipSync(bytes)),
  );
  return value;
};
const fragmentPage = v.object({
  seznam: v.array(
    v.object({
      id: v.number(),
      eli: v.string(),
      kodTypuFragmentu: v.string(),
      xhtml: v.optional(v.string()),
      hloubka: v.number(),
    }),
  ),
  pocetStranek: v.number(),
});
const sourceText = (xhtml: string) =>
  xhtml
    .replace(/<[^>]+>/gu, " ")
    .replaceAll("&nbsp;", " ")
    .replace(/\s+/gu, " ")
    .trim();
const report10 = v.parse(
  fragmentPage,
  await readCapture("cz-esbirka-10-2026-dz-page-0.json.gz"),
);
const report50 = v.parse(
  fragmentPage,
  await readCapture("cz-esbirka-50-2026-dz-page-0.json.gz"),
);
const enacted10 = v.parse(
  fragmentPage,
  await readCapture("cz-esbirka-10-2026-enacted-page-0.json.gz"),
);
const enacted50 = v.parse(
  fragmentPage,
  await readCapture("cz-esbirka-50-2026-enacted-page-0.json.gz"),
);
const oracle = v.parse(
  v.object({
    results: v.object({
      bindings: v.array(
        v.object({
          citace: v.object({ value: v.string() }),
          url: v.object({ value: v.string() }),
        }),
      ),
    }),
  }),
  await readCapture("cz-esbirka-358-2016-par-1.json.gz"),
);
const grammar = PROVISION_CITATION_GRAMMARS.CZE;
const provisionLevel = (
  reference: NonNullable<ReturnType<typeof grammar.parseReference>>,
) => {
  if (reference.point !== null) {
    return "point";
  }
  if (reference.letter !== null) {
    return "letter";
  }
  if (reference.subsection !== null) {
    return "subsection";
  }
  return "section";
};

/** A projection of recorded publisher references and anchors into the shared AST shape. */
const recordedAst = (): StatuteAst => {
  const nodes = new Map<string, ProvisionNode>();
  const references = oracle.results.bindings.map(({ citace, url }) => {
    const reference = grammar.parseReference(citace.value);
    if (reference === null) {
      return panic("Unparseable recorded provision");
    }
    const level = provisionLevel(reference);
    const num =
      level === "section"
        ? `${reference.section}${reference.sectionSuffix ?? ""}`
        : reference[level];
    const anchorId = new URL(url.value, "https://www.e-sbirka.cz").hash.slice(
      1,
    );
    expect(anchorId.length).toBeGreaterThan(0);
    const key = JSON.stringify(reference);
    expect(nodes.has(key)).toBe(false);
    nodes.set(key, {
      type: "provision",
      eId: url.value,
      wId: url.value,
      anchorId,
      kind: level,
      num,
      heading: null,
      plainText: citace.value,
      children: [],
    });
    return { reference, key };
  });
  // The bounded publisher projection may omit unchanged parents; empty anchor ids preserve that absence.
  const ensureParent = (
    reference: (typeof references)[number]["reference"],
  ): ProvisionNode => {
    const key = JSON.stringify(reference);
    const recorded = nodes.get(key);
    if (recorded !== undefined) {
      return recorded;
    }
    const level = provisionLevel(reference);
    const num =
      level === "section"
        ? `${reference.section}${reference.sectionSuffix ?? ""}`
        : reference[level];
    const node: ProvisionNode = {
      type: "provision",
      eId: key,
      wId: key,
      anchorId: "",
      kind: level,
      num,
      heading: null,
      plainText: "",
      children: [],
    };
    nodes.set(key, node);
    references.push({ reference, key });
    return node;
  };
  const body: ProvisionNode[] = [];
  for (const { reference, key } of references) {
    const node = nodes.get(key);
    if (node === undefined) {
      return panic("Missing recorded provision node");
    }
    if (node.kind === "section") {
      body.push(node);
      continue;
    }
    const parentReference = { ...reference, sentence: null };
    if (node.kind === "point") {
      parentReference.point = null;
    } else if (node.kind === "letter") {
      parentReference.letter = null;
    } else {
      parentReference.subsection = null;
    }
    const parent = ensureParent(parentReference);
    parent.children.push(node);
  }
  return {
    version: 1,
    metadata: {
      naturalId: "358/2016 Sb.",
      title: "Recorded provision projection",
      language: "cs",
      status: "consolidated",
      validFrom: "2026-02-01",
      validTo: null,
    },
    source: {
      system: "esbirka",
      eliExpressionUri: "https://www.e-sbirka.cz/eli/cz/sb/2016/358/2026-02-01",
      sourceUrl: "https://www.e-sbirka.cz/sb/2016/358/2026-02-01",
    },
    body,
  };
};
const ast = recordedAst();
const block = (heading: string): PendingExplanatoryBlock => ({
  status: "pending",
  id: heading,
  heading,
  scope: { type: "work", workIdentifier: "358/2016 Sb." },
});
const base = {
  jurisdiction: "CZE",
  works: [{ workIdentifier: "358/2016 Sb.", ast }],
  billPoints: [],
  enactedPoints: [],
  enactedCoverage: "complete",
  amendingWorkIdentifier: "10/2026 Sb.",
  introducedVersionWindow: {
    status: "versioned",
    validFrom: "2026-02-01",
    validTo: null,
  },
} as const;
const specialHeadings = (
  page: v.InferOutput<typeof fragmentPage>,
): PendingExplanatoryBlock[] => {
  let part: "general" | "special" = "general";
  const blocks: PendingExplanatoryBlock[] = [];
  for (const fragment of page.seznam) {
    if (fragment.kodTypuFragmentu === "Sekce_Zvlastni") {
      part = "special";
    }
    if (
      part !== "special" ||
      fragment.xhtml === undefined ||
      !fragment.kodTypuFragmentu.includes("Nadpis")
    ) {
      continue;
    }
    const heading = sourceText(fragment.xhtml);
    if (!heading.startsWith("K ")) {
      continue;
    }
    blocks.push({
      status: "pending",
      id: fragment.eli,
      heading,
      scope: fragment.eli.includes("/2026/50/")
        ? { type: "amendment", article: null, numbering: "enacted" }
        : { type: "work", workIdentifier: "358/2016 Sb." },
    });
  }
  return blocks;
};

describe("recorded explanatory report coverage", () => {
  test("captures contain both complete reports and their declared enactment pages", async () => {
    expect(report10.pocetStranek).toBe(1);
    expect(report10.seznam).toHaveLength(163);
    expect(report50.pocetStranek).toBe(1);
    expect(report50.seznam).toHaveLength(89);
    expect(enacted10.pocetStranek).toBe(2); // The captured page is intentionally a bounded instruction sample.
    expect(enacted10.seznam).toHaveLength(1000);
    expect(enacted50.pocetStranek).toBe(1);
    expect(enacted50.seznam).toHaveLength(53);
    const metadata = v.object({
      zobrazitDuvodovouZpravu: v.boolean(),
      datumUcinnostiZneniOd: v.string(),
    });
    for (const number of [10, 50]) {
      expect(
        v.parse(
          metadata,
          await readCapture(`cz-esbirka-${number}-2026-metadata.json.gz`),
        ).zobrazitDuvodovouZpravu,
      ).toBe(true);
    }
  });

  test("recorded direct report headings resolve to recorded base-act anchors", () => {
    const headings = specialHeadings(report10);
    for (const letter of ["k", "l"]) {
      const heading = headings.find(
        (entry) => entry.heading === `K § 1 písm. ${letter})`,
      );
      expect(heading).toBeDefined();
      if (heading === undefined) {
        continue;
      }
      const outcome = resolveExplanatoryBlocks({
        ...base,
        blocks: [heading],
      }).at(0);
      expect(outcome?.status).toBe("resolved");
      if (outcome?.status !== "resolved") {
        continue;
      }
      expect(outcome.attachments).toHaveLength(1);
      const anchor = outcome.attachments.at(0)?.provision.anchor;
      expect(anchor).toBe(`par_1-pism_${letter}`);
      expect(
        oracle.results.bindings.some(
          ({ url }) =>
            new URL(url.value, "https://www.e-sbirka.cz").hash.slice(1) ===
            anchor,
        ),
      ).toBe(true);
      expect(outcome.attachments.at(0)?.provision.workIdentifier).toBe(
        "358/2016 Sb.",
      );
      expect(outcome.attachments.at(0)?.introducedVersionWindow).toEqual(
        base.introducedVersionWindow,
      );
    }
  });

  test("every recorded special-part heading retains exactly one typed outcome", () => {
    for (const page of [report10, report50]) {
      const headings = specialHeadings(page);
      expect(headings.length).toBeGreaterThan(10);
      const results = resolveExplanatoryBlocks({ ...base, blocks: headings });
      expect(results).toHaveLength(headings.length);
      expect(new Set(results.map((result) => result.id)).size).toBe(
        headings.length,
      );
      expect(results.map((result) => result.id)).toEqual(
        headings.map((heading) => heading.id),
      );
      for (const result of results) {
        switch (result.status) {
          case "resolved":
            expect(result.attachments.length).toBeGreaterThan(0);
            break;
          case "unresolved_anchor":
            expect(result.reason.length).toBeGreaterThan(0);
            break;
          case "ambiguous":
            expect(result.reason.length).toBeGreaterThan(0);
            break;
          case "not_in_enacted_text":
            break;
          default:
            result satisfies never;
        }
      }
    }
  });

  test("the recorded enacted point resolves its affected letter", () => {
    const point = enacted10.seznam.find((fragment) =>
      fragment.eli.endsWith("/novela/cl_1/bod_2"),
    );
    expect(point).toBeDefined();
    if (point?.xhtml === undefined) {
      return;
    }
    const instruction = parseAmendmentInstruction({
      jurisdiction: "CZE",
      text: sourceText(point.xhtml),
    });
    expect(instruction.status).toBe("parsed");
    if (instruction.status !== "parsed") {
      return;
    }
    expect(instruction.targets.at(0)?.section).toBe(1);
    expect(instruction.targets.at(0)?.letter).toBe("j");
    expect(instruction.operations).toEqual(["replace"]);
  });
});

describe("AST confirmed attachment outcomes", () => {
  test("recorded explanatory attachment resolution is a fixed point", () => {
    const references = oracle.results.bindings
      .map(({ citace }) => grammar.parseReference(citace.value))
      .filter((reference) => reference !== null);
    assertProperty(
      "recorded explanatory attachment resolution is a fixed point",
      fc.property(
        fc.uniqueArray(fc.constantFrom(...references), {
          minLength: 1,
          maxLength: 6,
          selector: JSON.stringify,
        }),
        (targets) => {
          const heading = formatExplanatoryReferences(targets, "CZE");
          expect(heading).not.toBeNull();
          if (heading === null) {
            return;
          }
          const once = resolveExplanatoryBlocks({
            ...base,
            blocks: [block(heading)],
          });
          expect(once.at(0)?.status).toBe("resolved");
          expect(resolveExplanatoryBlocks({ ...base, blocks: once })).toEqual(
            once,
          );
        },
      ),
    );
  });

  test("absent, different and duplicate AST anchors never resolve", () => {
    const heading = block("K § 1 písm. k)");
    expect(
      resolveExplanatoryBlocks({ ...base, works: [], blocks: [heading] }).at(0)
        ?.status,
    ).toBe("unresolved_anchor");
    const different = structuredClone(ast);
    const replace = (nodes: readonly ProvisionNode[]) => {
      for (const node of nodes) {
        if (node.anchorId === "par_1-pism_k") {
          node.anchorId = "par_1-pism_k_2";
        }
        replace(node.children.filter((child) => child.type === "provision"));
      }
    };
    replace(different.body.filter((entry) => entry.type === "provision"));
    expect(
      resolveExplanatoryBlocks({
        ...base,
        works: [{ workIdentifier: "358/2016 Sb.", ast: different }],
        blocks: [heading],
      }).at(0)?.status,
    ).toBe("unresolved_anchor");
    const duplicate = { ...ast, body: [...ast.body, ...ast.body] };
    expect(
      resolveExplanatoryBlocks({
        ...base,
        works: [{ workIdentifier: "358/2016 Sb.", ast: duplicate }],
        blocks: [heading],
      }).at(0)?.status,
    ).toBe("ambiguous");
    expect(
      resolveExplanatoryBlocks({
        ...base,
        introducedVersionWindow: {
          status: "versioned",
          validFrom: "2025-01-01",
          validTo: null,
        },
        blocks: [heading],
      }).at(0)?.status,
    ).toBe("unresolved_anchor");
  });

  test("AST metadata must match both the selected act and its version window", () => {
    for (const metadata of [
      { ...ast.metadata, naturalId: "89/2012 Sb." },
      { ...ast.metadata, validTo: "2026-03-01" },
    ]) {
      expect(
        resolveExplanatoryBlocks({
          ...base,
          works: [
            { workIdentifier: "358/2016 Sb.", ast: { ...ast, metadata } },
          ],
          blocks: [block("K § 1 písm. k)")],
        }).at(0)?.status,
      ).toBe("unresolved_anchor");
    }
  });

  test("a partial enacted point sample cannot establish absence or bill alignment", () => {
    const heading: PendingExplanatoryBlock = {
      status: "pending",
      id: "partial",
      heading: "K bodu 999",
      scope: { type: "amendment", article: "1", numbering: "enacted" },
    };
    expect(
      resolveExplanatoryBlocks({
        ...base,
        enactedCoverage: "partial",
        blocks: [heading],
      }).at(0)?.status,
    ).toBe("unresolved_anchor");
  });

  test("missing publisher parent anchors remain unresolved", () => {
    expect(
      resolveExplanatoryBlocks({ ...base, blocks: [block("K § 1")] }).at(0)
        ?.status,
    ).toBe("unresolved_anchor");
  });

  test("structural headings fan out through explicit AST containers", () => {
    const container: ProvisionNode = {
      type: "provision",
      eId: "part",
      wId: "part",
      anchorId: "",
      kind: "part",
      num: "PRVNÍ",
      heading: null,
      plainText: "",
      children: ast.body,
    };
    const grouped = { ...ast, body: [container] };
    const result = resolveExplanatoryBlocks({
      ...base,
      works: [{ workIdentifier: "358/2016 Sb.", ast: grouped }],
      blocks: [block("K části první")],
    }).at(0);
    // Missing source anchors for unchanged parents prevent partial success of a structural group.
    expect(result?.status).toBe("unresolved_anchor");
  });

  test("recorded anchors survive ordinal case changes in structural containers", () => {
    const provision = ast.body.find(
      (entry) =>
        entry.type === "provision" &&
        entry.kind === "section" &&
        entry.anchorId !== "",
    );
    if (provision?.type !== "provision") {
      return panic("Missing recorded section anchor");
    }
    const ordinalCases = [
      ["PRVNÍ", "první"],
      ["DRUHÁ", "druhé"],
      ["TŘETÍ", "třetí"],
      ["ČTVRTÁ", "čtvrté"],
      ["PÁTÁ", "páté"],
      ["ŠESTÁ", "šesté"],
      ["SEDMÁ", "sedmé"],
      ["OSMÁ", "osmé"],
      ["DEVÁTÁ", "deváté"],
      ["DESÁTÁ", "desáté"],
    ] as const;
    const containers = [
      { kind: "part", title: "ČÁST", heading: "části" },
      { kind: "chapter", title: "HLAVA", heading: "hlavě" },
    ] as const;
    const assertContainer = (
      [nominative, locative]: (typeof ordinalCases)[number],
      { kind, title, heading }: (typeof containers)[number],
    ) => {
      const container: ProvisionNode = {
        type: "provision",
        eId: "ordinal-container",
        wId: "ordinal-container",
        anchorId: "",
        kind,
        num: `${title} ${nominative}`.normalize("NFD"),
        heading: null,
        plainText: "",
        children: [{ ...provision, children: [] }],
      };
      const result = resolveExplanatoryBlocks({
        ...base,
        works: [
          {
            workIdentifier: "358/2016 Sb.",
            ast: { ...ast, body: [container] },
          },
        ],
        blocks: [block(`K ${heading} ${locative}`.normalize("NFD"))],
      }).at(0);
      expect(result?.status).toBe("resolved");
      if (result?.status !== "resolved") {
        return;
      }
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments.at(0)?.provision.anchor).toBe(
        provision.anchorId,
      );
      expect(result.attachments.at(0)?.level).toBe("section");
    };
    assertContainer(["DRUHÁ", "druhé"], containers[0]);
    assertContainer(["ČTVRTÁ", "čtvrté"], containers[0]);
    assertProperty(
      "recorded anchors survive ordinal case changes in structural containers",
      fc.property(
        fc.constantFrom(...ordinalCases),
        fc.constantFrom(...containers),
        assertContainer,
      ),
    );
  });

  test("grouped targets retain levels and never drop an absent member", () => {
    const result = resolveExplanatoryBlocks({
      ...base,
      blocks: [block("K § 1 písm. k) a l)")],
    }).at(0);
    expect(result?.status).toBe("resolved");
    if (result?.status !== "resolved") {
      return;
    }
    expect(result.fanOut).toBe("grouped");
    expect(result.attachments.map((attachment) => attachment.level)).toEqual([
      "letter",
      "letter",
    ]);
    expect(
      resolveExplanatoryBlocks({
        ...base,
        blocks: [block("K § 1 písm. k), § 9999")],
      }).at(0)?.status,
    ).toBe("unresolved_anchor");
  });

  test("bill numbering is aligned before an AST-confirmed attachment", () => {
    const source = enacted10.seznam.find((fragment) =>
      fragment.eli.endsWith("/novela/cl_1/bod_3"),
    );
    expect(source?.xhtml).toBeDefined();
    if (source?.xhtml === undefined) {
      return;
    }
    const text = sourceText(source.xhtml);
    const enacted = {
      id: source.eli,
      article: "1",
      point: 3,
      text,
      workIdentifier: "358/2016 Sb.",
    };
    const bill = {
      ...enacted,
      id: "bill-seven",
      point: 7,
      text: text.replace(/^3\./u, "7."),
    };
    const heading: PendingExplanatoryBlock = {
      status: "pending",
      id: "report",
      heading: "K bodu 7",
      scope: { type: "amendment", article: "1", numbering: "bill" },
    };
    const options = {
      ...base,
      blocks: [heading],
      billPoints: [bill],
      enactedPoints: [enacted],
    };
    const result = resolveExplanatoryBlocks(options).at(0);
    expect(result?.status).toBe("resolved");
    if (result?.status !== "resolved") {
      return;
    }
    expect(result.attachments.at(0)?.selection).toEqual({
      type: "aligned_bill_point",
      billPointId: bill.id,
      enactedPointId: enacted.id,
    });
    expect(
      resolveExplanatoryBlocks({ ...options, enactedPoints: [] }).at(0)?.status,
    ).toBe("not_in_enacted_text");
    expect(
      resolveExplanatoryBlocks({
        ...options,
        enactedPoints: [enacted, { ...enacted, id: "duplicate" }],
      }).at(0)?.status,
    ).toBe("ambiguous");
    expect(
      resolveExplanatoryBlocks({
        ...options,
        enactedPoints: [
          { ...enacted, text: "2. V § 1 písm. j) se slovo „a“ zrušuje." },
        ],
      }).at(0)?.status,
    ).toBe("not_in_enacted_text");
  });
});
