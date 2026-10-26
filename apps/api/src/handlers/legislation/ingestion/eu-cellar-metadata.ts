import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import type {
  LegislationPublisherDateEvidence,
  LegislationPublisherDateMeaning,
} from "@stll/api-contract/legislation-publisher-evidence";
import { compareCodeUnit } from "@stll/collation";
import { declareFingerprintFields } from "@stll/errors";
import { parsePlainDate } from "@stll/time";

import { EU_CELLAR_LIMITS } from "./eu-cellar-limits";

const CDM = "http://publications.europa.eu/ontology/cdm#";
const OWL = "http://www.w3.org/2002/07/owl#";
const ANNOTATION = "http://publications.europa.eu/ontology/annotation#";
const CELLAR = "http://publications.europa.eu/resource/cellar/";
const ENGLISH = "http://publications.europa.eu/resource/authority/language/ENG";
const { metadataStatements: MAX_STATEMENTS } = EU_CELLAR_LIMITS;

const valueSchema = v.pipe(v.string(), v.maxLength(16_384));
const uriSchema = v.object({ type: v.literal("uri"), value: valueSchema });
const literalSchema = v.object({
  type: v.picklist(["literal", "typed-literal"]),
  value: valueSchema,
  datatype: v.optional(v.string()),
  "xml:lang": v.optional(v.string()),
});
const termSchema = v.union([
  uriSchema,
  literalSchema,
  v.object({ type: v.literal("bnode"), value: valueSchema }),
]);
const statementSchema = v.object({
  s: v.union([
    uriSchema,
    v.object({ type: v.literal("bnode"), value: valueSchema }),
  ]),
  p: uriSchema,
  o: termSchema,
});
const responseSchema = v.object({
  results: v.object({
    bindings: v.pipe(v.array(statementSchema), v.maxLength(MAX_STATEMENTS)),
  }),
});
type Statement = v.InferOutput<typeof statementSchema>;
type Term = Statement["o"];
type Graph = Map<string, Map<string, Term[]>>;

class EuCellarMetadataError extends TaggedError("EuCellarMetadataError")<{
  message: string;
  reason: "identity" | "malformed" | "conflict" | "language" | "incomplete";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const keyOf = (term: Term): string => {
  if (term.type === "uri" || term.type === "bnode") {
    return `${term.type}:${term.value}`;
  }
  const language = term["xml:lang"]?.toLowerCase() ?? "";
  const datatype =
    language.length > 0
      ? "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString"
      : (term.datatype ?? "http://www.w3.org/2001/XMLSchema#string");
  return JSON.stringify(["literal", term.value, datatype, language]);
};
const valuesOf = (graph: Graph, subject: string, predicate: string) =>
  graph.get(subject)?.get(predicate) ?? [];
const literalValues = (terms: Term[]) =>
  terms.flatMap((term) =>
    term.type === "literal" || term.type === "typed-literal"
      ? [term.value]
      : [],
  );
const distinct = (values: string[]) =>
  [...new Set(values)].toSorted(compareCodeUnit);

const indexStatements = (statements: Statement[]): Graph => {
  const graph: Graph = new Map();
  for (const { s, p, o } of statements) {
    const subject = keyOf(s);
    let predicates = graph.get(subject);
    if (predicates === undefined) {
      predicates = new Map();
      graph.set(subject, predicates);
    }
    const objects = predicates.get(p.value) ?? [];
    objects.push(o);
    predicates.set(p.value, objects);
  }
  return graph;
};

/** Identities name publisher resources, never arbitrary fetch targets. */
export const validCellarIri = (iri: string) => {
  if (!iri.startsWith(CELLAR)) {
    return false;
  }
  const suffix = iri.slice(CELLAR.length);
  const [uuid, ...versions] = suffix.split(".");
  return (
    v.safeParse(v.pipe(v.string(), v.uuid()), uuid).success &&
    versions.every((part) => /^\d+$/u.test(part))
  );
};

type MetadataIdentity = {
  workIri: string;
  expressionIri: string;
  textWorkIri?: string;
};

const dateMeaning = (predicate: string, codes: string[]) => {
  const authority = "http://publications.europa.eu/resource/authority/fd_335/";
  const has = (code: string) =>
    codes.some(
      (value) =>
        value === code ||
        value === `${authority}${code}` ||
        value === `{${code}|${authority}${code}}`,
    );
  if (has("MA") && has("EV")) {
    return Result.err(
      new EuCellarMetadataError({
        message: "Conflicting publisher date roles",
        reason: "conflict",
      }),
    );
  }
  if (has("MA")) {
    return Result.ok({
      type: "applicability",
    } as const satisfies LegislationPublisherDateMeaning);
  }
  if (has("EV")) {
    return Result.ok({
      type: "entry-into-force",
    } as const satisfies LegislationPublisherDateMeaning);
  }
  if (predicate === `${CDM}resource_legal_date_end-of-validity`) {
    return Result.ok({
      type: "end-of-validity",
    } as const satisfies LegislationPublisherDateMeaning);
  }
  if (predicate === `${CDM}work_date_publication`) {
    return Result.ok({
      type: "publication",
    } as const satisfies LegislationPublisherDateMeaning);
  }
  return Result.ok({
    type: "other",
    publisherCode: predicate,
  } as const satisfies LegislationPublisherDateMeaning);
};

const DATE_PREDICATES = new Set([
  `${CDM}work_date_document`,
  `${CDM}work_date_publication`,
  `${CDM}resource_legal_date_entry-into-force`,
  `${CDM}resource_legal_date_end-of-validity`,
]);

const uniqueTerms = (terms: Term[]) => [
  ...new Map(terms.map((term) => [keyOf(term), term])).values(),
];

/** All admitted aliases denote one Work; literal datatype and language remain significant. */
const dateAssertionKey = (predicate: string, target: Term) =>
  JSON.stringify([predicate, keyOf(target)]);

type DateAxiomsOptions = { graph: Graph; subjects: Set<string> };

const dateAxioms = ({ graph, subjects }: DateAxiomsOptions) => {
  const axioms = new Map<string, string[]>();
  for (const [subject] of graph) {
    const sources = uniqueTerms(
      valuesOf(graph, subject, `${OWL}annotatedSource`),
    );
    if (!sources.some((source) => subjects.has(keyOf(source)))) {
      continue;
    }
    const predicates = uniqueTerms(
      valuesOf(graph, subject, `${OWL}annotatedProperty`),
    );
    const targets = uniqueTerms(
      valuesOf(graph, subject, `${OWL}annotatedTarget`),
    );
    if (
      sources.length !== 1 ||
      targets.length !== 1 ||
      predicates.length === 0 ||
      predicates.length > 16
    ) {
      return Result.err(
        new EuCellarMetadataError({
          message: "Publisher annotation exceeds statement association bounds",
          reason: "malformed",
        }),
      );
    }
    const target = targets.at(0);
    if (target === undefined) {
      continue;
    }
    for (const predicate of predicates) {
      if (predicate.type !== "uri") {
        return Result.err(
          new EuCellarMetadataError({
            message: "Publisher annotation property is not an IRI",
            reason: "malformed",
          }),
        );
      }
      if (!DATE_PREDICATES.has(predicate.value)) {
        continue;
      }
      const key = dateAssertionKey(predicate.value, target);
      const entries = axioms.get(key) ?? [];
      entries.push(subject);
      axioms.set(key, entries);
    }
  }
  return Result.ok(axioms);
};

type DateEvidenceItemOptions = {
  graph: Graph;
  statement: Statement;
  axiom: string | null;
};

const dateEvidenceItem = ({
  graph,
  statement: { s, p, o },
  axiom,
}: DateEvidenceItemOptions) => {
  const codes =
    axiom === null
      ? []
      : distinct(
          valuesOf(graph, axiom, `${ANNOTATION}type_of_date`).map(
            ({ value }) => value,
          ),
        );
  const comments =
    axiom === null
      ? []
      : distinct(
          literalValues(valuesOf(graph, axiom, `${ANNOTATION}comment_on_date`)),
        );
  const locations =
    axiom === null
      ? []
      : distinct(
          literalValues(
            valuesOf(
              graph,
              axiom,
              `${ANNOTATION}reference_to_modified_location`,
            ),
          ),
        );
  const meaning = dateMeaning(p.value, codes);
  if (meaning.isErr()) {
    return Result.err(meaning.error);
  }
  const date =
    o.value === "9999-12-31"
      ? null
      : (parsePlainDate(o.value)?.toString() ?? null);
  const language =
    o.type === "literal" || o.type === "typed-literal"
      ? o["xml:lang"]
      : undefined;
  const item: LegislationPublisherDateEvidence = {
    meaning: meaning.value,
    lexicalValue: o.value,
    normalizedDate: date,
    scope:
      locations.length === 0
        ? { type: "work" }
        : { type: "provision", rawLocator: locations.join("\n") },
    locator: `${s.value}#${p.value}`,
    ...(codes.length + comments.length === 0
      ? {}
      : { annotation: JSON.stringify({ codes, comments }) }),
    ...(language === undefined ? {} : { language }),
  };
  return Result.ok(item);
};

type DateEvidenceOptions = DateAxiomsOptions & { statements: Statement[] };

const dateEvidence = ({ graph, subjects, statements }: DateEvidenceOptions) => {
  const indexed = dateAxioms({ graph, subjects });
  if (indexed.isErr()) {
    return Result.err(indexed.error);
  }
  const evidence: LegislationPublisherDateEvidence[] = [];
  const seenDates = new Set<string>();
  const seen = new Set<string>();
  for (const statement of statements) {
    const { s, p, o } = statement;
    if (
      !subjects.has(keyOf(s)) ||
      !DATE_PREDICATES.has(p.value) ||
      o.type === "uri" ||
      o.type === "bnode"
    ) {
      continue;
    }
    const assertion = dateAssertionKey(p.value, o);
    if (seenDates.has(assertion)) {
      continue;
    }
    seenDates.add(assertion);
    const matching = indexed.value.get(assertion) ?? [];
    for (const axiom of matching.length === 0 ? [null] : matching) {
      const item = dateEvidenceItem({ graph, statement, axiom });
      if (item.isErr()) {
        return Result.err(item.error);
      }
      const key = JSON.stringify(item.value);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      evidence.push(item.value);
    }
  }
  return Result.ok(
    evidence.toSorted((a, b) =>
      compareCodeUnit(JSON.stringify(a), JSON.stringify(b)),
    ),
  );
};

const workSubjects = (statements: Statement[], workIri: string) => {
  const subjects = new Set([`uri:${workIri}`]);
  for (const { s, p, o } of statements) {
    if (p.value !== `${OWL}sameAs` || s.type !== "uri" || o.type !== "uri") {
      continue;
    }
    if (s.value === workIri) {
      subjects.add(keyOf(o));
    }
    if (o.value === workIri) {
      subjects.add(keyOf(s));
    }
  }
  return subjects;
};

const publisherBoolean = (value: string) => {
  if (value === "true" || value === "1") {
    return "true";
  }
  if (value === "false" || value === "0") {
    return "false";
  }
  return "invalid";
};

type ExpressionFactsOptions = {
  graph: Graph;
  expression: string;
  textSubjects: Set<string>;
};

const readExpressionFacts = ({
  graph,
  expression,
  textSubjects,
}: ExpressionFactsOptions) => {
  const belongs = valuesOf(
    graph,
    expression,
    `${CDM}expression_belongs_to_work`,
  );
  if (
    belongs.length === 0 ||
    !belongs.every(
      (term) => term.type === "uri" && textSubjects.has(keyOf(term)),
    )
  ) {
    return Result.err(
      new EuCellarMetadataError({
        message: "Expression does not belong to the requested Work",
        reason: "identity",
      }),
    );
  }
  const languageTerms = valuesOf(
    graph,
    expression,
    `${CDM}expression_uses_language`,
  );
  const languages = distinct(languageTerms.map(({ value }) => value));
  if (
    languageTerms.some((term) => term.type !== "uri") ||
    languages.length !== 1 ||
    languages.at(0) !== ENGLISH
  ) {
    return Result.err(
      new EuCellarMetadataError({
        message: "Only an explicitly English expression is enabled",
        reason: "language",
      }),
    );
  }
  const titleTerms = valuesOf(graph, expression, `${CDM}expression_title`);
  if (
    titleTerms.some(
      (term) =>
        (term.type === "literal" || term.type === "typed-literal") &&
        term["xml:lang"] !== undefined &&
        term["xml:lang"].toLowerCase() !== "en",
    )
  ) {
    return Result.err(
      new EuCellarMetadataError({
        message: "Expression title language conflicts with its expression",
        reason: "language",
      }),
    );
  }
  const titles = distinct(literalValues(titleTerms));
  const title = titles.at(0);
  if (titles.length !== 1 || title === undefined || title.trim().length === 0) {
    return Result.err(
      new EuCellarMetadataError({
        message: "Expression requires one stated title",
        reason: "conflict",
      }),
    );
  }
  return Result.ok({ title });
};

type ParseMetadataOptions = MetadataIdentity & { response: unknown };

/** Normalize only assertions attached to this Work and expression. */
export const parseEuCellarMetadata = ({
  workIri,
  expressionIri,
  textWorkIri = workIri,
  response,
}: ParseMetadataOptions) => {
  if (![workIri, expressionIri, textWorkIri].every(validCellarIri)) {
    return Result.err(
      new EuCellarMetadataError({
        message: "Invalid CELLAR metadata identity",
        reason: "identity",
      }),
    );
  }
  const parsed = v.safeParse(responseSchema, response);
  if (!parsed.success) {
    return Result.err(
      new EuCellarMetadataError({
        message: "Malformed or oversized CELLAR statement response",
        reason: "malformed",
      }),
    );
  }
  const statements = parsed.output.results.bindings;
  const graph = indexStatements(statements);
  const expression = `uri:${expressionIri}`;
  const subjects = workSubjects(statements, workIri);
  const textSubjects =
    textWorkIri === workIri ? subjects : workSubjects(statements, textWorkIri);
  if (textWorkIri !== workIri) {
    const consolidated = [...subjects].flatMap((subject) =>
      valuesOf(
        graph,
        subject,
        `${CDM}resource_legal_consolidated_by_act_consolidated`,
      ),
    );
    if (
      !consolidated.some(
        (term) => term.type === "uri" && textSubjects.has(keyOf(term)),
      )
    ) {
      return Result.err(
        new EuCellarMetadataError({
          message:
            "Text Work is not a stated consolidation of the requested Work",
          reason: "identity",
        }),
      );
    }
  }
  const expressionFacts = readExpressionFacts({
    graph,
    expression,
    textSubjects,
  });
  if (expressionFacts.isErr()) {
    return Result.err(expressionFacts.error);
  }
  const { title } = expressionFacts.value;
  const all = (predicate: string) =>
    [...subjects].flatMap((subject) =>
      valuesOf(graph, subject, `${CDM}${predicate}`),
    );
  const typeTerms = all("work_has_resource-type");
  const types = distinct(typeTerms.map(({ value }) => value));
  const resourceType = types.at(0);
  if (
    typeTerms.some((term) => term.type !== "uri") ||
    types.length !== 1 ||
    resourceType === undefined
  ) {
    return Result.err(
      new EuCellarMetadataError({
        message: "Work requires one stated resource type",
        reason: "conflict",
      }),
    );
  }
  const celex = distinct(literalValues(all("resource_legal_id_celex")));
  const identifiers = distinct(
    [...subjects]
      .map((subject) => subject.slice(4))
      .concat(
        celex,
        all("resource_legal_eli").map(({ value }) => value),
      ),
  );
  if (
    celex.length === 0 ||
    identifiers.length > 64 ||
    identifiers.some((value) => value.length === 0 || value.length > 512)
  ) {
    return Result.err(
      new EuCellarMetadataError({
        message: "Work identifiers are missing or exceed bounds",
        reason: "incomplete",
      }),
    );
  }
  const force = distinct(literalValues(all("resource_legal_in-force")));
  const forceValues = force.map(publisherBoolean);
  const forceValue = new Set(forceValues);
  if (forceValue.size > 1 || forceValue.has("invalid")) {
    return Result.err(
      new EuCellarMetadataError({
        message: "Conflicting or invalid in-force assertions",
        reason: "conflict",
      }),
    );
  }
  const celexTypes = distinct(literalValues(all("resource_legal_type")));
  if (celexTypes.length > 1) {
    return Result.err(
      new EuCellarMetadataError({
        message: "Conflicting publisher act type codes",
        reason: "conflict",
      }),
    );
  }
  const dates = dateEvidence({ graph, subjects, statements });
  if (dates.isErr()) {
    return Result.err(dates.error);
  }
  const textDates =
    textWorkIri === workIri
      ? Result.ok([])
      : dateEvidence({ graph, subjects: textSubjects, statements });
  if (textDates.isErr()) {
    return Result.err(textDates.error);
  }
  const locator = `${workIri}#${CDM}resource_legal_in-force`;
  return Result.ok({
    workIri,
    textWorkIri,
    expressionIri,
    title,
    resourceType,
    identifiers,
    celex,
    expressionKind:
      textWorkIri === workIri
        ? ("promulgated" as const)
        : ("consolidation" as const),
    celexTypes,
    publisherEvidence: {
      inForce:
        forceValues.length === 0
          ? { status: "not-stated" as const, locator }
          : {
              status: "stated" as const,
              value: forceValues.at(0) === "true",
              locator,
            },
      dates: [...dates.value, ...textDates.value].toSorted((a, b) =>
        compareCodeUnit(JSON.stringify(a), JSON.stringify(b)),
      ),
    },
    // Includes annotated amendment/corrigendum observations without claiming
    // a provision relation or a complete legal history.
    statements,
  });
};
