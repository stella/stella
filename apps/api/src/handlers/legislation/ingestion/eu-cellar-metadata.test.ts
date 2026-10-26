import { panic } from "better-result";
import { expect, test } from "bun:test";

import { parseEuCellarMetadata } from "@/api/handlers/legislation/ingestion/eu-cellar-metadata";

const CDM = "http://publications.europa.eu/ontology/cdm#";
const OWL = "http://www.w3.org/2002/07/owl#";
const ANNOTATION = "http://publications.europa.eu/ontology/annotation#";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const WORK =
  "http://publications.europa.eu/resource/cellar/11111111-1111-4111-8111-111111111111";
const EXPRESSION = `${WORK}.0006`;
const TEXT =
  "http://publications.europa.eu/resource/cellar/22222222-2222-4222-8222-222222222222";
const OTHER =
  "http://publications.europa.eu/resource/cellar/33333333-3333-4333-8333-333333333333";
const ALIAS = "http://publications.europa.eu/resource/celex/32021R2139";
const ENGLISH = "http://publications.europa.eu/resource/authority/language/ENG";
const REGULATION =
  "http://publications.europa.eu/resource/authority/resource-type/REG_DEL";

const uri = (value: string) => ({ type: "uri" as const, value });
const literal = (value: string) => ({ type: "literal" as const, value });
const blank = (value: string) => ({ type: "bnode" as const, value });
const date = (value: string) => ({
  type: "literal" as const,
  value,
  datatype: `${XSD}date`,
});
type TestTerm = ReturnType<typeof uri | typeof literal | typeof blank> & {
  datatype?: string;
  "xml:lang"?: string;
};
type FactOptions = { s?: TestTerm; p: string; o: TestTerm };
const fact = ({ s = uri(WORK), p, o }: FactOptions) => ({ s, p: uri(p), o });

const base = () => [
  fact({
    s: uri(EXPRESSION),
    p: `${CDM}expression_belongs_to_work`,
    o: uri(WORK),
  }),
  fact({
    s: uri(EXPRESSION),
    p: `${CDM}expression_uses_language`,
    o: uri(ENGLISH),
  }),
  fact({
    s: uri(EXPRESSION),
    p: `${CDM}expression_title`,
    o: literal("Delegated Regulation"),
  }),
  fact({ p: `${CDM}work_has_resource-type`, o: uri(REGULATION) }),
  fact({ p: `${CDM}resource_legal_id_celex`, o: literal("32021R2139") }),
  fact({ p: `${CDM}resource_legal_type`, o: literal("R") }),
];

type Bindings = ReturnType<typeof base>;
const parse = (bindings: Bindings) =>
  parseEuCellarMetadata({
    workIri: WORK,
    expressionIri: EXPRESSION,
    response: { results: { bindings } },
  });
const parsedValue = (bindings: Bindings) => {
  const result = parse(bindings);
  if (result.isErr()) {
    return panic(result.error.message);
  }
  return result.value;
};
const reason = (result: ReturnType<typeof parse>) => {
  if (result.isOk()) {
    return panic("expected metadata to be refused");
  }
  return result.error.reason;
};

type AxiomOptions = {
  name: string;
  target: string;
  code: string;
  source?: string;
};
const axiom = ({ name, target, code, source = ALIAS }: AxiomOptions) => [
  fact({ s: blank(name), p: `${OWL}annotatedSource`, o: uri(source) }),
  fact({
    s: blank(name),
    p: `${OWL}annotatedProperty`,
    o: uri(`${CDM}resource_legal_date_entry-into-force`),
  }),
  fact({ s: blank(name), p: `${OWL}annotatedTarget`, o: date(target) }),
  fact({ s: blank(name), p: `${ANNOTATION}type_of_date`, o: literal(code) }),
];

test("Work aliases associate EV and MA annotations without flattening date roles", () => {
  const bindings = [
    ...base(),
    fact({ p: `${OWL}sameAs`, o: uri(ALIAS) }),
    fact({
      p: `${CDM}resource_legal_date_entry-into-force`,
      o: date("2021-12-29"),
    }),
    fact({
      p: `${CDM}resource_legal_date_entry-into-force`,
      o: date("2022-01-01"),
    }),
    ...axiom({ name: "ev", target: "2021-12-29", code: "EV" }),
    ...axiom({
      name: "ma",
      target: "2022-01-01",
      code: "{MA|http://publications.europa.eu/resource/authority/fd_335/MA}",
    }),
    fact({
      s: blank("ma"),
      p: `${ANNOTATION}reference_to_modified_location`,
      o: literal("AR 3"),
    }),
  ];
  const parsed = parsedValue(bindings);
  expect(parsed.expressionKind).toBe("promulgated");
  expect(parsed.publisherEvidence.dates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        meaning: { type: "entry-into-force" },
        lexicalValue: "2021-12-29",
      }),
      expect.objectContaining({
        meaning: { type: "applicability" },
        lexicalValue: "2022-01-01",
        scope: { type: "provision", rawLocator: "AR 3" },
      }),
    ]),
  );
  expect(parsed.publisherEvidence.dates).toHaveLength(2);
  expect(parsedValue(bindings.toReversed()).publisherEvidence).toEqual(
    parsed.publisherEvidence,
  );
});

test("literal term identity ignores JSON key order and respects datatype and language", () => {
  const bindings = [
    ...base(),
    fact({ p: `${OWL}sameAs`, o: uri(ALIAS) }),
    fact({
      p: `${CDM}resource_legal_date_entry-into-force`,
      o: date("2021-12-29"),
    }),
    ...axiom({ name: "ev", target: "2021-12-29", code: "EV" }).map(
      (statement) =>
        statement.p.value === `${OWL}annotatedTarget`
          ? {
              ...statement,
              o: {
                datatype: `${XSD}date`,
                value: "2021-12-29",
                type: "typed-literal" as const,
              },
            }
          : statement,
    ),
    ...axiom({ name: "different-type", target: "2021-12-29", code: "MA" }).map(
      (statement) =>
        statement.p.value === `${OWL}annotatedTarget`
          ? { ...statement, o: literal("2021-12-29") }
          : statement,
    ),
    ...axiom({
      name: "different-language",
      target: "2021-12-29",
      code: "MA",
    }).map((statement) =>
      statement.p.value === `${OWL}annotatedTarget`
        ? { ...statement, o: { ...literal("2021-12-29"), "xml:lang": "en" } }
        : statement,
    ),
  ];
  const result = parseEuCellarMetadata({
    workIri: WORK,
    expressionIri: EXPRESSION,
    response: { results: { bindings } },
  });
  if (result.isErr()) {
    panic(result.error.message);
  }
  expect(result.value.publisherEvidence.dates).toHaveLength(1);
  expect(result.value.publisherEvidence.dates.at(0)?.meaning).toEqual({
    type: "entry-into-force",
  });
});

test("a consolidation is tied to its stated base Work without importing text identifiers as aliases", () => {
  const textAlias =
    "http://publications.europa.eu/resource/celex/02021R2139-20230101";
  const bindings = [
    ...base().filter(({ p }) => p.value !== `${CDM}expression_belongs_to_work`),
    fact({
      s: uri(EXPRESSION),
      p: `${CDM}expression_belongs_to_work`,
      o: uri(TEXT),
    }),
    fact({
      p: `${CDM}resource_legal_consolidated_by_act_consolidated`,
      o: uri(TEXT),
    }),
    fact({ s: uri(TEXT), p: `${OWL}sameAs`, o: uri(textAlias) }),
    fact({
      s: uri(TEXT),
      p: `${CDM}resource_legal_id_celex`,
      o: literal("02021R2139-20230101"),
    }),
    fact({
      s: uri(TEXT),
      p: `${CDM}work_date_document`,
      o: date("2023-01-01"),
    }),
  ];
  const options = {
    workIri: WORK,
    expressionIri: EXPRESSION,
    textWorkIri: TEXT,
  };
  const result = parseEuCellarMetadata({
    ...options,
    response: { results: { bindings } },
  });
  if (result.isErr()) {
    panic(result.error.message);
  }
  expect(result.value.expressionKind).toBe("consolidation");
  expect(result.value.celex).toEqual(["32021R2139"]);
  expect(result.value.identifiers).not.toContain(textAlias);
  expect(result.value.identifiers).not.toContain("02021R2139-20230101");
  expect(result.value.publisherEvidence.dates).toEqual([
    expect.objectContaining({
      lexicalValue: "2023-01-01",
      locator: `${TEXT}#${CDM}work_date_document`,
      meaning: { type: "other", publisherCode: `${CDM}work_date_document` },
    }),
  ]);
  const wrongBase = parseEuCellarMetadata({
    ...options,
    response: {
      results: {
        bindings: bindings.filter(
          ({ p }) =>
            p.value !== `${CDM}resource_legal_consolidated_by_act_consolidated`,
        ),
      },
    },
  });
  expect(reason(wrongBase)).toBe("identity");
});

test("a conflicting expression parent is refused even if one parent matches", () => {
  expect(
    reason(
      parse([
        ...base(),
        fact({
          s: uri(EXPRESSION),
          p: `${CDM}expression_belongs_to_work`,
          o: uri(OTHER),
        }),
      ]),
    ),
  ).toBe("identity");
});

test("contradictory roles in one date annotation are refused", () => {
  expect(
    reason(
      parse([
        ...base(),
        fact({ p: `${OWL}sameAs`, o: uri(ALIAS) }),
        fact({
          p: `${CDM}resource_legal_date_entry-into-force`,
          o: date("2021-12-29"),
        }),
        ...axiom({ name: "conflict", target: "2021-12-29", code: "EV" }),
        fact({
          s: blank("conflict"),
          p: `${ANNOTATION}type_of_date`,
          o: literal("MA"),
        }),
      ]),
    ),
  ).toBe("conflict");
});

test("unknown dates and publisher sentinels remain lexical evidence", () => {
  const result = parsedValue([
    ...base(),
    fact({
      p: `${CDM}resource_legal_date_end-of-validity`,
      o: date("9999-12-31"),
    }),
    fact({ p: `${CDM}work_date_document`, o: literal("not-a-date") }),
  ]);
  expect(result.publisherEvidence.dates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        lexicalValue: "9999-12-31",
        normalizedDate: null,
        meaning: { type: "end-of-validity" },
      }),
      expect.objectContaining({
        lexicalValue: "not-a-date",
        normalizedDate: null,
        meaning: { type: "other", publisherCode: `${CDM}work_date_document` },
      }),
    ]),
  );
  expect(result.publisherEvidence.inForce.status).toBe("not-stated");
});

test("unrelated facts and axioms do not become Work evidence", () => {
  const result = parsedValue([
    ...base(),
    fact({
      s: uri(OTHER),
      p: `${CDM}resource_legal_in-force`,
      o: literal("false"),
    }),
    fact({
      s: uri(OTHER),
      p: `${CDM}work_has_resource-type`,
      o: uri("unknown"),
    }),
    fact({
      s: uri(OTHER),
      p: `${CDM}work_date_document`,
      o: date("2020-01-01"),
    }),
    ...axiom({
      name: "unrelated",
      target: "2020-01-01",
      code: "MA",
      source: OTHER,
    }),
  ]);
  expect(result.resourceType).toBe(REGULATION);
  expect(result.publisherEvidence.dates).toEqual([]);
  expect(result.publisherEvidence.inForce.status).toBe("not-stated");
});

test("unknown resource codes survive for the family classifier to refuse", () => {
  const result = parsedValue(
    base().map((statement) =>
      statement.p.value === `${CDM}work_has_resource-type`
        ? { ...statement, o: uri("publisher:unclassified") }
        : statement,
    ),
  );
  expect(result.resourceType).toBe("publisher:unclassified");
});

test.each(["FRA", "", "ENG,FRA"])(
  "non-English or ambiguous language %s is refused",
  (language) => {
    const bindings = base().filter(
      ({ p }) => p.value !== `${CDM}expression_uses_language`,
    );
    for (const code of language.length === 0 ? [] : language.split(",")) {
      bindings.push(
        fact({
          s: uri(EXPRESSION),
          p: `${CDM}expression_uses_language`,
          o: uri(
            `http://publications.europa.eu/resource/authority/language/${code}`,
          ),
        }),
      );
    }
    expect(reason(parse(bindings))).toBe("language");
  },
);

test.each([
  `${WORK}> } UNION { ?s ?p ?o`,
  `${WORK}.`,
  "https://example.test/work",
  `${WORK}/path`,
])("publisher identity %p is refused", (workIri) => {
  const result = parseEuCellarMetadata({
    workIri,
    expressionIri: EXPRESSION,
    response: { results: { bindings: base() } },
  });
  expect(result.isErr()).toBe(true);
});

test("statement overflow is refused before graph construction", () => {
  const filler = fact({
    p: `${CDM}work_date_document`,
    o: literal("2020-01-01"),
  });
  expect(reason(parse(Array.from({ length: 20_001 }, () => filler)))).toBe(
    "malformed",
  );
});

test("literal resource/language lookalikes and conflicting title/type assertions are refused", () => {
  const values = base();
  const language = values.map((entry) =>
    entry.p.value === `${CDM}expression_uses_language`
      ? { ...entry, o: literal(ENGLISH) }
      : entry,
  );
  expect(reason(parse(language))).toBe("language");
  const type = values.map((entry) =>
    entry.p.value === `${CDM}work_has_resource-type`
      ? { ...entry, o: literal(REGULATION) }
      : entry,
  );
  expect(reason(parse(type))).toBe("conflict");
  expect(
    reason(
      parse([
        ...values,
        fact({ p: `${CDM}resource_legal_type`, o: literal("D") }),
      ]),
    ),
  ).toBe("conflict");
  const title = values.map((entry) =>
    entry.p.value === `${CDM}expression_title`
      ? { ...entry, o: { ...literal("A title"), "xml:lang": "cs" } }
      : entry,
  );
  expect(reason(parse(title))).toBe("language");
});

test.each(["source", "target", "properties"])(
  "annotation %s multiplicity is bounded before associations expand",
  (mode) => {
    const bindings = [
      ...base(),
      fact({ p: `${OWL}sameAs`, o: uri(ALIAS) }),
      ...axiom({ name: "bounded", target: "2021-12-29", code: "EV" }),
    ];
    if (mode === "source") {
      bindings.push(
        fact({ s: blank("bounded"), p: `${OWL}annotatedSource`, o: uri(WORK) }),
      );
    }
    if (mode === "target") {
      bindings.push(
        fact({
          s: blank("bounded"),
          p: `${OWL}annotatedTarget`,
          o: date("2022-01-01"),
        }),
      );
    }
    if (mode === "properties") {
      for (let index = 0; index < 16; index += 1) {
        bindings.push(
          fact({
            s: blank("bounded"),
            p: `${OWL}annotatedProperty`,
            o: uri(`${CDM}property_${index}`),
          }),
        );
      }
    }
    expect(reason(parse(bindings))).toBe("malformed");
  },
);
