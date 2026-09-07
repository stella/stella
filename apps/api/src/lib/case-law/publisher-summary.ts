import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import type { ApparatusRole, DocumentAst } from "@stll/legal-ast/document-ast";

/**
 * What a publisher says about a decision, in the two kinds it comes in: the
 * headnote — the sentence a reader recognises the case by, written by whoever
 * published it rather than by the court — and the keywords, the subject index
 * and legal areas the decision was filed under. Every jurisdiction the corpus
 * covers publishes both under different names and in different places, so the
 * sources are declared once, in order, and every consumer walks these lists.
 *
 * Order within a kind is from the most to the least specific, and it is the
 * same for every court, so a decision's headnote means the same thing across
 * jurisdictions. Adding a jurisdiction means adding a source here, never a
 * branch anywhere else.
 */

/**
 * Publisher-authored paragraphs a parser can already recognise structurally.
 * A parser that marks these roles beats any metadata key: the text is the
 * publisher's own, in document order, with no key naming convention in
 * between.
 *
 * `apparatus` and `counsel` are apparatus too but are not headnotes: the
 * first is unnamed publisher matter, the second is who appeared.
 */
const PUBLISHER_HEADNOTE_AST_ROLES = [
  "headnotes",
  "syllabus",
  "summary",
] as const satisfies readonly ApparatusRole[];

/** How one metadata value is read into text. */
type PublisherSummaryValueShape = "text" | "list";

/**
 * What a source's value is. A headnote is a sentence somebody wrote about the
 * decision; keywords are the terms it was indexed and filed under. Both are
 * the publisher's, and a reader with no headnote is better served by the tags
 * than by an empty line, but they are not the same kind of text: one is prose,
 * the other a classification. The kind therefore travels with the source, and
 * a consumer that has to keep them apart — the corpus index gives each its own
 * field — asks for one list or the other instead of re-deciding per key.
 */
type PublisherSummaryKind = "headnote" | "keywords";

type PublisherSummarySourceOf<Kind extends PublisherSummaryKind> =
  | { kind: Kind; origin: "ast"; roles: readonly ApparatusRole[] }
  | {
      kind: Kind;
      origin: "metadata";
      key: string;
      shape: PublisherSummaryValueShape;
    };

type PublisherSummarySource = PublisherSummarySourceOf<PublisherSummaryKind>;

/**
 * Every place a headnote can live, best first. Each metadata key is one an
 * adapter records verbatim from its source; a key arrives here with the
 * adapter that writes it, never before one.
 */
const PUBLISHER_HEADNOTE_SOURCES = [
  { kind: "headnote", origin: "ast", roles: PUBLISHER_HEADNOTE_AST_ROLES },
  { kind: "headnote", origin: "metadata", key: "legalSentence", shape: "text" },
  { kind: "headnote", origin: "metadata", key: "abstract", shape: "text" },
  { kind: "headnote", origin: "metadata", key: "summary", shape: "text" },
] as const satisfies readonly PublisherSummarySourceOf<"headnote">[];

/**
 * Every place a decision's classification can live, best first: the subject
 * index the publisher assigned, then the areas of law they filed it under.
 */
const PUBLISHER_KEYWORD_SOURCES = [
  { kind: "keywords", origin: "metadata", key: "keywords", shape: "list" },
  { kind: "keywords", origin: "metadata", key: "legalAreas", shape: "list" },
  { kind: "keywords", origin: "metadata", key: "legalArea", shape: "text" },
] as const satisfies readonly PublisherSummarySourceOf<"keywords">[];

/**
 * Both lists as one, headnotes first: the order the single line a reader sees
 * resolves in, and the order the SQL reading below walks.
 */
export const PUBLISHER_SUMMARY_SOURCES = [
  ...PUBLISHER_HEADNOTE_SOURCES,
  ...PUBLISHER_KEYWORD_SOURCES,
] as const;

/** Items of a list-shaped source, as one line. */
const LIST_SEPARATOR = " · ";

/** Publisher paragraphs, kept as paragraphs. */
const PARAGRAPH_SEPARATOR = "\n\n";

/**
 * The whitespace both implementations strip, spelled out rather than left to
 * each engine's default: PostgreSQL's one-argument `btrim` removes spaces
 * only, where JavaScript's `trim` removes every whitespace character. The set
 * below is what a publisher payload carries, and the binding test holds the
 * two readings to the same answer over it.
 *
 * Vertical tab is written `\x0B` on the SQL side rather than `\v`, and the
 * reason is the manual, not the behaviour: Table 4.1 lists `\b \f \n \r \t`,
 * the numeric escapes, and nothing else, while "any other character following
 * a backslash is taken literally". The lexer does accept `\v` — this was
 * checked against the engine — but a set built on an escape the documentation
 * does not promise would put a literal `v` in it the day that stops being
 * true, and `btrim` would then eat the leading preposition of every summary
 * opening with one ("v řízení"). `\x0B` is documented and identical, so the
 * hazard is spelled away rather than relied against. The binding test pins
 * both the trimming and that no leading word is lost.
 */
const TRIMMED_WHITESPACE = " \t\n\r\f\v";
const TRIMMED_WHITESPACE_SQL = "E' \\t\\n\\r\\f\\x0B'";
const TRIM_PATTERN = new RegExp(
  `^[${TRIMMED_WHITESPACE}]+|[${TRIMMED_WHITESPACE}]+$`,
  "gu",
);

const trimmed = (value: string): string | null => {
  const text = value.replaceAll(TRIM_PATTERN, "");
  return text.length === 0 ? null : text;
};

const READ_METADATA_VALUE = {
  text: (value) => (typeof value === "string" ? trimmed(value) : null),
  list: (value) => {
    if (!Array.isArray(value)) {
      return null;
    }
    const items: string[] = [];
    for (const item of value) {
      const text = typeof item === "string" ? trimmed(item) : null;
      if (text !== null) {
        items.push(text);
      }
    }
    return items.length === 0 ? null : items.join(LIST_SEPARATOR);
  },
} as const satisfies Record<
  PublisherSummaryValueShape,
  (value: unknown) => string | null
>;

/**
 * A metadata key as a SQL literal rather than a bound parameter. The keys are
 * this module's own constants, and `->>` is overloaded on its right operand,
 * so an untyped parameter there is ambiguous to the planner.
 */
const jsonKey = (key: string): SQL => sql.raw(`'${key.replaceAll("'", "''")}'`);

const trimSql = (value: SQL): SQL =>
  sql`nullif(btrim(${value}, ${sql.raw(TRIMMED_WHITESPACE_SQL)}), '')`;

/**
 * Each shape as SQL, reading exactly what its TypeScript reading reads: a
 * JSON string for `text`, the string items of a JSON array for `list`. The
 * type guards are not defensive — an untyped `->>` would render a number as
 * text where TypeScript skips it, and the two would disagree.
 */
const METADATA_VALUE_SQL = {
  text: (metadata, key) =>
    sql`CASE jsonb_typeof(${metadata} -> ${jsonKey(key)})
          WHEN 'string' THEN ${trimSql(sql`${metadata} ->> ${jsonKey(key)}`)}
        END`,
  list: (metadata, key) =>
    sql`nullif(
      (
        SELECT string_agg(
                 btrim(item.value #>> '{}', ${sql.raw(TRIMMED_WHITESPACE_SQL)}),
                 ${LIST_SEPARATOR}
                 ORDER BY item.ordinality
               )
        FROM jsonb_array_elements(
          CASE jsonb_typeof(${metadata} -> ${jsonKey(key)})
            WHEN 'array' THEN ${metadata} -> ${jsonKey(key)}
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY AS item(value, ordinality)
        WHERE jsonb_typeof(item.value) = 'string'
          AND btrim(item.value #>> '{}', ${sql.raw(TRIMMED_WHITESPACE_SQL)}) <> ''
      ),
      ''
    )`,
} as const satisfies Record<
  PublisherSummaryValueShape,
  (metadata: SQLWrapper, key: string) => SQL
>;

const astSummary = (
  documentAst: DocumentAst | null,
  roles: readonly ApparatusRole[],
): string | null => {
  if (documentAst === null) {
    return null;
  }
  const paragraphs: string[] = [];
  for (const block of documentAst.blocks) {
    if (
      block.type !== "paragraph" ||
      !roles.some((role) => role === block.role)
    ) {
      continue;
    }
    const text = trimmed(block.plainText);
    if (text !== null) {
      paragraphs.push(text);
    }
  }
  return paragraphs.length === 0 ? null : paragraphs.join(PARAGRAPH_SEPARATOR);
};

export type PublisherSummaryInput = {
  documentAst: DocumentAst | null;
  metadata: Record<string, unknown> | null;
};

/** The first source of a list that has something, or null when none has. */
const firstSourceText = (
  sources: readonly PublisherSummarySource[],
  { documentAst, metadata }: PublisherSummaryInput,
): string | null => {
  for (const source of sources) {
    switch (source.origin) {
      case "ast": {
        const text = astSummary(documentAst, source.roles);
        if (text !== null) {
          return text;
        }
        break;
      }
      case "metadata": {
        const text = READ_METADATA_VALUE[source.shape](metadata?.[source.key]);
        if (text !== null) {
          return text;
        }
        break;
      }
      default: {
        source satisfies never;
        return panic(`Unhandled source: ${String(source)}`);
      }
    }
  }
  return null;
};

/**
 * The publisher's own sentence about the decision, and only that: a
 * classification cannot come back from here, because the list this walks holds
 * no classification source. Null where no publisher wrote one.
 */
export const publisherHeadnoteOf = (
  input: PublisherSummaryInput,
): string | null => firstSourceText(PUBLISHER_HEADNOTE_SOURCES, input);

/** The terms the publisher indexed and filed the decision under. */
export const publisherKeywordsOf = (
  input: PublisherSummaryInput,
): string | null => firstSourceText(PUBLISHER_KEYWORD_SOURCES, input);

/**
 * One line for a reader: the headnote, or the classification where there is no
 * headnote. Null when the publisher supplied neither, so a consumer omits the
 * line rather than rendering an empty one.
 */
export const publisherSummaryOf = (
  input: PublisherSummaryInput,
): string | null => publisherHeadnoteOf(input) ?? publisherKeywordsOf(input);

/**
 * The same list, as one SQL expression over a decision's `metadata`, and the
 * reason it is a strict subset: the AST sources live in an object the read
 * path does not load, and joining a multi-megabyte document per row to reach
 * three paragraphs would cost far more than the line is worth. The projection
 * path already holds the AST and therefore evaluates the whole list, so an
 * indexed summary is a superset of a displayed one: never a different answer,
 * only a better one where a parser marked the roles.
 */
export const publisherSummaryMetadataSql = (
  metadata: SQLWrapper,
): SQL<string | null> => {
  const arms: SQL[] = [];
  for (const source of PUBLISHER_SUMMARY_SOURCES) {
    if (source.origin === "metadata") {
      arms.push(METADATA_VALUE_SQL[source.shape](metadata, source.key));
    }
  }
  return sql<string | null>`coalesce(${sql.join(arms, sql`, `)})`;
};
