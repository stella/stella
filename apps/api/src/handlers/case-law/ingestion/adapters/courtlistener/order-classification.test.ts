import { describe, expect, test } from "bun:test";

import {
  classifyCourtListenerDecision,
  type PrincipalTextEvidence,
  SHORT_ORDER_MAX_CHARACTERS,
} from "./order-classification";
import type { OpinionType } from "./vocabulary";

const parsed = (
  body: string,
  evidence: Partial<
    Omit<
      Extract<PrincipalTextEvidence, { status: "parsed" }>,
      "status" | "body"
    >
  > = {},
): PrincipalTextEvidence => ({
  status: "parsed",
  body,
  orderHeading: false,
  structuralOpinion: false,
  singleOpinionBody: false,
  ...evidence,
});

const classify = (
  opinionTypes: readonly OpinionType[],
  principal: PrincipalTextEvidence,
  scdbPresent = false,
) => classifyCourtListenerDecision({ opinionTypes, principal, scdbPresent });

const LONG_REASONING =
  "The question presented is whether the statute applies to the conduct at issue. ".repeat(
    8,
  );

describe("orders are decisions of their own class", () => {
  test.each([
    [
      "a certiorari denial with its court below",
      "C. A. 9th Cir. Certiorari denied.",
    ],
    [
      "a consolidated denial with the reports below",
      "C. A. 8th Cir.; C. A. 7th Cir.; and C. A. 5th Cir. Certiorari denied. Reported below: No. 90-1628, 920 F. 2d 498; No. 91-5013, 925 F. 2d 1064; No. 91-5087, 931 F. 2d 890.",
    ],
    [
      "a denial with a noted vote",
      "C. A. 6th Cir. Certiorari denied. Justice White would grant certiorari.",
    ],
    [
      "a pauper motion and a denial",
      "Motion of petitioner for leave to proceed in forma pauperis granted. Certiorari denied.",
    ],
    [
      "a grant, vacatur and remand",
      "Certiorari granted, judgment vacated, and case remanded to the United States Court of Appeals for the Ninth Circuit for further consideration in light of Smith v. Jones, 500 U.S. 1 (1991).",
    ],
    [
      "a dismissed appeal",
      "Appeal dismissed for want of substantial federal question.",
    ],
    ["a rehearing denial", "Petition for rehearing denied."],
    [
      "a written-out petition disposition",
      "The petition for a writ of certiorari is denied.",
    ],
    ["a summary affirmance", "The judgment is summarily affirmed."],
    ["a bare disposition without a period", "Affirmed"],
    ["a vacatur and remand", "Vacated and Remanded"],
    [
      "adjacent motion dispositions without a space",
      "Motion for leave to appeal denied.Motion for poor person relief dismissed as academic.",
    ],
    [
      "a certification petition naming a report",
      "The petition of the plaintiffs for certification for appeal from the Appellate Court, 1 Conn. App. 417, is denied.",
    ],
  ])("%s published as a lead opinion is an order", (_name, body) => {
    const classification = classify(["020lead"], parsed(body));

    expect(classification.kind).toBe("order");
    expect(classification.decisionType).toBe("order");
    expect(classification.evidence.matchedPatterns.length).toBeGreaterThan(0);
  });

  test("a separate dissent does not turn a classified order into an opinion", () => {
    const classification = classify(
      ["020lead", "040dissent"],
      parsed("C. A. 5th Cir. Certiorari denied."),
    );

    expect(classification.kind).toBe("order");
  });

  test("an explicit order heading or a motion-to-strike row is an order at any length", () => {
    expect(
      classify(["010combined"], parsed(LONG_REASONING, { orderHeading: true }))
        .kind,
    ).toBe("order");
    expect(classify(["090onmotiontostrike"], parsed(LONG_REASONING)).kind).toBe(
      "order",
    );
    expect(
      classify(["090onmotiontostrike"], { status: "unavailable" }).kind,
    ).toBe("order");
  });

  test.each([
    ["a quoted order", 'The clerk entered "Certiorari denied." in error.'],
    [
      "an order phrase inside reasoning",
      "The petitioner argues that certiorari granted in a prior case controls; we disagree.",
    ],
    [
      "an order sentence followed by reasoning",
      "Certiorari denied. The court below plainly erred in its reading.",
    ],
  ])("%s is not order wording", (_name, body) => {
    const classification = classify(["010combined"], parsed(body));

    expect(classification.kind).toBe("unclassified");
    expect(classification.evidence.matchedPatterns).toEqual([]);
  });

  test("a body past the short-order bound is never an order by wording", () => {
    const body = "Certiorari denied. ".repeat(40);

    expect(Array.from(body.trim()).length).toBeGreaterThan(
      SHORT_ORDER_MAX_CHARACTERS,
    );
    expect(classify(["010combined"], parsed(body)).kind).toBe("unclassified");
  });

  test("an adversarial near-order body is read in bounded time", () => {
    const body = `${"The motion of the party is granted and the ".repeat(11)}remainder follows`;
    const started = performance.now();

    expect(classify(["010combined"], parsed(body)).kind).toBe("unclassified");
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("supporting sentences", () => {
  test.each([
    ["a vote note", "Justice White would grant certiorari."],
    ["a report of the decision below", "Reported below: 123 F.3d 456."],
    [
      "a recusal",
      "Justice Kennedy took no part in the consideration or decision of this petition.",
    ],
  ])("%s alone is not an order", (_name, body) => {
    for (const types of [["010combined"], ["040dissent"]] as const) {
      const classification = classify(types, parsed(body));

      expect(classification.kind).toBe("unclassified");
      expect(classification.evidence.matchedPatterns).toEqual([]);
    }
  });

  test("a dissent-only principal is not an order; an order with a dissent is", () => {
    const dissentOnly = classify(
      ["040dissent"],
      parsed("Justice White would grant certiorari."),
    );
    const withDissent = classify(
      ["020lead", "040dissent"],
      parsed("Certiorari denied. Justice White would grant certiorari."),
    );

    expect(dissentOnly.decisionType).toBe("decision");
    expect(withDissent.decisionType).toBe("order");
    expect(withDissent.evidence.matchedPatterns).toEqual([
      "certiorari-disposition",
      "justice-vote-note",
    ]);
  });
});

describe("opinions", () => {
  test("a short body the order sentences miss is never an opinion by row type or wrapper", () => {
    const body = "The judgment of the Court of Appeals is reversed.";

    for (const types of [
      ["020lead"],
      ["015unamimous"],
      ["040dissent"],
    ] as const) {
      expect(classify(types, parsed(body)).kind).toBe("unclassified");
      expect(
        classify(types, parsed(body, { structuralOpinion: true })).kind,
      ).toBe("unclassified");
    }
  });

  test("an opinion type or publisher structure makes a long body an opinion once no order rule holds", () => {
    expect(classify(["030concurrence"], parsed(LONG_REASONING)).kind).toBe(
      "opinion",
    );
    expect(
      classify(
        ["010combined"],
        parsed(LONG_REASONING, { structuralOpinion: true }),
      ).kind,
    ).toBe("opinion");
  });

  test("a long combined body needs SCDB linkage or one proven opinion body", () => {
    expect(classify(["010combined"], parsed(LONG_REASONING), true).kind).toBe(
      "opinion",
    );
    expect(
      classify(
        ["010combined"],
        parsed(LONG_REASONING, { singleOpinionBody: true }),
      ).kind,
    ).toBe("opinion");

    const insufficient = classify(["010combined"], parsed(LONG_REASONING));
    expect(insufficient.kind).toBe("unclassified");
    expect(insufficient.decisionType).toBe("decision");
  });
});

describe("insufficient evidence", () => {
  test("without the principal text only the row types can decide, and a lead opinion type cannot", () => {
    const classification = classify(["020lead"], { status: "unavailable" });

    expect(classification.kind).toBe("unclassified");
    expect(classification.rule).toBe("principal-text-unavailable");
  });

  test("a short combined body without order wording stays unclassified, not an opinion", () => {
    const body = "  Judgment affirmed\n on the opinion below. ";
    const classification = classify(["010combined"], parsed(body));

    expect(classification.kind).toBe("unclassified");
    expect(classification.evidence.principalLength).toBe(
      "Judgment affirmed on the opinion below.".length,
    );
  });
});
