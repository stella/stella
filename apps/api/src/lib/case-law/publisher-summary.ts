import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import type { ApparatusRole, DocumentAst } from "@stll/legal-ast/document-ast";

/**
 * The publisher's own summary of a decision: the sentence a reader
 * recognises the case by, written by whoever published it rather than by the
 * court. Every jurisdiction the corpus covers has one under a different name
 * and in a different place, so the sources are declared once, in order, and
 * every consumer walks that one list.
 *
 * Order is from the most to the least specific, and it is the same for every
 * court, so a decision's summary means the same thing across jurisdictions.
 * Adding a jurisdiction means adding a source here, never a branch anywhere
 * else.
 */

/**
 * Publisher-authored paragraphs a parser can already recognise structurally.
 * A parser that marks these roles beats any metadata key: the text is the
 * publisher's own, in document order, with no key naming convention in
 * between.
 *
 * `apparatus` and `counsel` are apparatus too but are not summaries: the
 * first is unnamed publisher matter, the second is who appeared.
 */
const PUBLISHER_SUMMARY_AST_ROLES = [
  "headnotes",
  "syllabus",
  "summary",
] as const satisfies readonly ApparatusRole[];

/** How one metadata value is read into summary text. */
type PublisherSummaryValueShape = "text" | "list";

type PublisherSummarySource =
  | { origin: "ast"; roles: readonly ApparatusRole[] }
  | { origin: "metadata"; key: string; shape: PublisherSummaryValueShape };

/**
 * Every place a publisher summary can live, best first. Each metadata key is
 * one an adapter records verbatim from its source; a key arrives here with the
 * adapter that writes it, never before one.
 */
export const PUBLISHER_SUMMARY_SOURCES = [
  { origin: "ast", roles: PUBLISHER_SUMMARY_AST_ROLES },
  { origin: "metadata", key: "legalSentence", shape: "text" },
  { origin: "metadata", key: "abstract", shape: "text" },
  { origin: "metadata", key: "summary", shape: "text" },
  { origin: "metadata", key: "keywords", shape: "list" },
  { origin: "metadata", key: "legalAreas", shape: "list" },
  { origin: "metadata", key: "legalArea", shape: "text" },
] as const satisfies readonly PublisherSummarySource[];

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

type PublisherSummaryInput = {
  documentAst: DocumentAst | null;
  metadata: Record<string, unknown> | null;
};

/**
 * The first source that has something, over the full list. Null when the
 * publisher supplied nothing, so a consumer omits the line rather than
 * rendering an empty one.
 */
export const publisherSummaryOf = ({
  documentAst,
  metadata,
}: PublisherSummaryInput): string | null => {
  for (const source of PUBLISHER_SUMMARY_SOURCES) {
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
