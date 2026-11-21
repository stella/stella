import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { normalizeDecisionIdentifierIn } from "@/api/handlers/case-law/ingestion/citation-extractor";

import { COURTLISTENER_SOURCE_FIELD_INVENTORY } from "./inventory";
import { planCourtListenerRecord } from "./plan";
import { decodeCourtListenerRaw } from "./raw";
import {
  citationRow,
  clusterRow,
  courtListenerRecord,
  courtRow,
  docketRow,
  opinionRow,
  personRow,
  recordedClusters,
} from "./test-records";

const plan = (input: unknown) => planCourtListenerRecord(input).unwrap();

const rejectionOf = (input: unknown) => {
  const planned = planCourtListenerRecord(input);
  if (Result.isOk(planned)) {
    throw new Error("expected the record to be rejected");
  }
  return planned.error;
};

const onCourt = (courtId: string) =>
  courtListenerRecord({
    docket: docketRow({ court_id: courtId }),
    court: courtRow({ id: courtId }),
  });

describe("the court a CourtListener record is written under", () => {
  test("a directory court sets the exact ID and canonical name", () => {
    const planned = plan(courtListenerRecord());

    expect(planned.courtId).toBe("scotus");
    expect(planned.court).toBe("Supreme Court of the United States");
  });

  test("unknown and rejected courts are separate reasons, and every accepted court is written", () => {
    expect(rejectionOf(onCourt("no-such-court")).reason).toBe("court-unknown");
    expect(rejectionOf(onCourt("test")).reason).toBe("court-rejected");
    expect(plan(onCourt("ca9")).courtId).toBe("ca9");
  });

  test("the court is matched by exact spelling, never folded", () => {
    expect(rejectionOf(onCourt("SCOTUS")).reason).toBe("court-unknown");
  });
});

describe("the primary reference", () => {
  test("a U.S. Reports tuple wins over a parallel reporter and the docket", () => {
    const planned = plan(
      courtListenerRecord({
        citations: [
          citationRow({
            id: "1",
            volume: "112",
            reporter: "S. Ct.",
            page: "422",
          }),
          citationRow({
            id: "2",
            volume: "502",
            reporter: "U. S.",
            page: "959",
          }),
        ],
      }),
    );

    expect(planned.caseNumber).toBe("502 U.S. 959");
    expect(planned.caseNumberType).toBe("reporter-citation");
  });

  test("another complete reporter tuple wins where no U.S. Reports tuple is complete", () => {
    const planned = plan(
      courtListenerRecord({
        citations: [
          citationRow({ id: "1", volume: "502", reporter: "U.S.", page: "" }),
          citationRow({
            id: "2",
            volume: "112",
            reporter: "S. Ct.",
            page: "422",
          }),
        ],
      }),
    );

    expect(planned.caseNumber).toBe("112 S. Ct. 422");
    expect(planned.diagnostics).toContainEqual({
      code: "incomplete-citation-tuple",
      path: "citations.0",
    });
  });

  test("the docket is primary only where no reporter tuple is complete", () => {
    const planned = plan(courtListenerRecord({ citations: [] }));

    expect(planned.caseNumber).toBe("No. 91-5746");
    expect(planned.caseNumberType).toBe("case-number");
  });

  test("ties break by reporter spelling, volume, page, then numeric citation ID", () => {
    const later = citationRow({
      id: "10",
      volume: "502",
      reporter: "U.S.",
      page: "960",
    });
    const earlier = citationRow({
      id: "9",
      volume: "502",
      reporter: "U.S.",
      page: "959",
    });
    const lowest = citationRow({
      id: "100",
      volume: "501",
      reporter: "U.S.",
      page: "999",
    });
    const orders = [
      [later, earlier, lowest],
      [lowest, earlier, later],
      [earlier, lowest, later],
    ];

    for (const citations of orders) {
      expect(plan(courtListenerRecord({ citations })).caseNumber).toBe(
        "501 U.S. 999",
      );
    }
  });

  test("a neutral citation alone is never primary", () => {
    const rejection = rejectionOf(
      courtListenerRecord({
        docket: docketRow({ docket_number: "  " }),
        citations: [
          citationRow({
            volume: "2025",
            reporter: "OK",
            page: "74",
            type: "8",
          }),
        ],
      }),
    );

    expect(rejection.reason).toBe("missing-primary-reference");
  });
});

describe("the identifiers", () => {
  test("list every parallel, neutral and docket reference once, primary first", () => {
    const planned = plan(
      courtListenerRecord({
        citations: [
          citationRow({
            id: "1",
            volume: "502",
            reporter: "U.S.",
            page: "959",
          }),
          citationRow({
            id: "2",
            volume: "502",
            reporter: "U. S.",
            page: "959",
          }),
          citationRow({
            id: "3",
            volume: "112",
            reporter: "S. Ct.",
            page: "422",
          }),
          citationRow({
            id: "4",
            volume: "1991",
            reporter: "OK",
            page: "7",
            type: "8",
          }),
        ],
      }),
    );

    expect(planned.identifiers).toEqual([
      { type: "reporter-citation", value: "502 U.S. 959" },
      { type: "reporter-citation", value: "112 S. Ct. 422" },
      { type: "neutral-citation", value: "1991 OK 7" },
      { type: "case-number", value: "No. 91-5746" },
    ]);
    const keys = planned.identifiers.map(
      (identifier) =>
        `${identifier.type}:${normalizeDecisionIdentifierIn("USA", identifier)}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a journal parallel is kept beside the primary and survives raw replay", () => {
    const journal = citationRow({
      id: "2",
      volume: "72",
      reporter: "Soc. Sec. Rep. Serv.",
      page: "318",
      type: "9",
    });
    const planned = plan(
      courtListenerRecord({ citations: [citationRow({ id: "1" }), journal] }),
    );
    const replayed = plan(
      decodeCourtListenerRaw({
        raw: planned.sourceRaw,
        contentType: planned.sourceRawContentType,
      }).unwrap(),
    );

    expect(planned.caseNumber).toBe("502 U.S. 959");
    expect(planned.identifiers).toContainEqual({
      type: "reporter-citation",
      value: "72 Soc. Sec. Rep. Serv. 318",
    });
    expect(planned.diagnostics).toContainEqual({
      code: "reporter-grammar-unresolved",
      path: "citations.1",
    });
    expect(replayed.identifiers).toEqual(planned.identifiers);
    expect(replayed.rawHash).toBe(planned.rawHash);
  });

  test("a tuple outside the reporter table is kept as printed, with a diagnostic", () => {
    const planned = plan(
      courtListenerRecord({
        citations: [
          citationRow({ id: "1" }),
          citationRow({
            id: "2",
            volume: "1991",
            reporter: "U.S. LEXIS",
            page: "6317",
            type: "6",
          }),
        ],
      }),
    );

    expect(planned.identifiers).toContainEqual({
      type: "reporter-citation",
      value: "1991 U.S. LEXIS 6317",
    });
    expect(planned.diagnostics).toContainEqual({
      code: "reporter-grammar-unresolved",
      path: "citations.1",
    });
  });

  test("more identifiers than a decision may hold reject the cluster, never truncate", () => {
    const citations = Array.from({ length: 32 }, (_, index) =>
      citationRow({
        id: String(index + 1),
        volume: String(index + 1),
        reporter: "U.S. LEXIS",
        page: "1",
        type: "6",
      }),
    );

    expect(
      plan(courtListenerRecord({ citations: citations.slice(0, 31) }))
        .identifiers,
    ).toHaveLength(32);
    expect(rejectionOf(courtListenerRecord({ citations })).reason).toBe(
      "identifier-overflow",
    );
  });

  test("an identifier past the stored length rejects the cluster", () => {
    expect(
      rejectionOf(
        courtListenerRecord({
          docket: docketRow({ docket_number: "9".repeat(257) }),
        }),
      ).reason,
    ).toBe("invalid-identifier");
  });
});

describe("the judges", () => {
  test("an explicit dissent is dissenting; a concurrence never is", () => {
    const planned = plan(
      courtListenerRecord({
        opinions: [
          opinionRow({ id: "1", type: "020lead", author_str: "Kennedy" }),
          opinionRow({ id: "2", type: "030concurrence", author_str: "Scalia" }),
          opinionRow({
            id: "3",
            type: "035concurrenceinpart",
            author_str: "O'Connor",
          }),
          opinionRow({ id: "4", type: "040dissent", author_str: "White" }),
        ],
      }),
    );

    expect(planned.judges).toEqual([
      { role: "panel-member", nameAsPrinted: "Kennedy" },
      { role: "panel-member", nameAsPrinted: "Scalia" },
      { role: "panel-member", nameAsPrinted: "O'Connor" },
      { role: "dissenting", nameAsPrinted: "White" },
    ]);
  });

  test("a per curiam opinion names no judge, not even one called Per Curiam", () => {
    const opinions = [
      opinionRow({ per_curiam: "t", author_str: "Kennedy", author_id: "31" }),
      opinionRow({ per_curiam: "f", author_str: "PER CURIAM." }),
    ];

    for (const opinion of opinions) {
      expect(
        plan(courtListenerRecord({ opinions: [opinion] })).judges,
      ).toBeUndefined();
    }
  });

  test("an author ID resolves only through supplied people, and joiners take the opinion's role", () => {
    const record = courtListenerRecord({
      opinions: [opinionRow({ id: "4", type: "040dissent", author_id: "31" })],
      judgeRelations: {
        status: "complete",
        people: [
          personRow({
            id: "31",
            name_first: "Byron",
            name_middle: "R.",
            name_last: "White",
          }),
          personRow({
            id: "32",
            name_first: "Harry",
            name_middle: "",
            name_last: "Blackmun",
            name_suffix: "jr",
          }),
        ],
        joinedBy: [{ opinionId: "4", personId: "32" }],
      },
    });

    expect(plan(record).judges).toEqual([
      { role: "dissenting", nameAsPrinted: "Byron R. White" },
      { role: "dissenting", nameAsPrinted: "Harry Blackmun Jr." },
    ]);
  });

  test("without supplied people an author ID stays an ID, and joiner text stays unsplit", () => {
    const planned = plan(
      courtListenerRecord({
        opinions: [
          opinionRow({
            author_id: "31",
            joined_by_str: "Rehnquist, C.J., and Scalia, J.",
          }),
        ],
      }),
    );

    expect(planned.judges).toBeUndefined();
    expect(planned.metadata["judgeAttribution"]).toEqual({
      relations: "unavailable",
      unresolvedCount: 2,
      unresolved: [
        { opinionId: "9109419", kind: "author-id", value: "31" },
        {
          opinionId: "9109419",
          kind: "joined-by-text",
          value: "Rehnquist, C.J., and Scalia, J.",
        },
      ],
    });
  });
});

describe("dates, links and order", () => {
  test("an approximate date is kept as stated and flagged, never reconstructed", () => {
    const planned = plan(
      courtListenerRecord({
        cluster: clusterRow({
          date_filed: "1795-07-15",
          date_filed_is_approximate: "t",
        }),
      }),
    );

    expect(planned.decisionDate).toBe("1795-07-15");
    expect(planned.metadata["dateFiled"]).toEqual({
      value: "1795-07-15",
      approximate: true,
    });
    expect(planned.diagnostics).toContainEqual({
      code: "date-filed-approximate",
      path: "cluster.date_filed",
    });
  });

  test("a date outside policy is absent with a diagnostic, and the decision is kept", () => {
    const planned = plan(
      courtListenerRecord({
        cluster: clusterRow({ date_filed: "1491-02-30" }),
      }),
    );

    expect(planned.decisionDate).toBeUndefined();
    expect(planned.diagnostics).toContainEqual({
      code: "date-filed-out-of-policy",
      path: "cluster.date_filed",
    });
  });

  test("opinions are ordered by type then numeric ID, whatever the input order", () => {
    const opinions = [
      opinionRow({ id: "100", type: "040dissent" }),
      opinionRow({ id: "20", type: "020lead" }),
      opinionRow({ id: "9", type: "030concurrence" }),
      opinionRow({ id: "10", type: "030concurrence" }),
    ];

    for (const input of [opinions, opinions.toReversed()]) {
      expect(
        plan(courtListenerRecord({ opinions: input })).opinions.map(
          ({ scopeId }) => scopeId,
        ),
      ).toEqual([
        "cl-opinion:20",
        "cl-opinion:9",
        "cl-opinion:10",
        "cl-opinion:100",
      ]);
    }
  });

  test("the case page carries a plain slug only, and the document URL only a usable address", () => {
    const planned = plan(
      courtListenerRecord({
        cluster: clusterRow({ slug: "../../admin" }),
        opinions: [opinionRow({ download_url: "data:text/html,<p>x</p>" })],
      }),
    );

    expect(planned.sourceUrl).toBe(
      "https://www.courtlistener.com/opinion/9114912/",
    );
    expect(planned.documentUrl).toBeUndefined();
    expect(plan(courtListenerRecord()).sourceUrl).toBe(
      "https://www.courtlistener.com/opinion/9114912/daniels-v-borg/",
    );
  });
});

describe("the field inventory", () => {
  test("every metadata key it declares stored is one the plan writes", () => {
    const planned = plan(
      courtListenerRecord({
        cluster: clusterRow({
          judges: "White",
          case_name_short: "Daniels",
          case_name_full: "Daniels v. Borg, Warden",
          scdb_id: "1991-001",
          source: "C",
          procedural_history: "p",
          attorneys: "a",
          nature_of_suit: "n",
          posture: "p",
          disposition: "d",
          history: "h",
          other_dates: "o",
          cross_reference: "c",
          correction: "c",
          date_blocked: "2020-01-01",
        }),
        docket: docketRow({
          appeal_from_str: "C. A. 9th Cir.",
          date_argued: "1991-10-01",
          docket_number_core: "91-5746",
          docket_number_raw: "91-5746",
        }),
      }),
    );
    const declared = new Set(
      Object.values(COURTLISTENER_SOURCE_FIELD_INVENTORY.fields).flatMap(
        (disposition) =>
          disposition.target.type === "metadata"
            ? [disposition.target.key]
            : [],
      ),
    );

    expect(
      [...declared].filter((key) => !Object.hasOwn(planned.metadata, key)),
    ).toEqual([]);
  });
});

describe("recorded snapshot clusters", () => {
  const recorded = new Map(
    recordedClusters().map((record) => [record.cluster.id, record]),
  );
  const planRecorded = (clusterId: string) => plan(recorded.get(clusterId));

  test("a full opinion takes its U.S. Reports tuple over the docket column", () => {
    expect(planRecorded("103998").caseNumber).toBe("322 U.S. 385");
  });

  test("a state court the directory accepts is written under its own id", () => {
    expect(planRecorded("4329445").courtId).toBe("nyappdiv");
  });
});
