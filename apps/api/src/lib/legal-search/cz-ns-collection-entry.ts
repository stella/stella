import { panic } from "better-result";
/**
 * One entry of the Supreme Court's official collection, the Sbírka soudních
 * rozhodnutí a stanovisek (sbirka.nsoud.cz), as the decision row keeps it.
 *
 * The collection publishes decisions the court selected and edited for print:
 * its own, its predecessors' (Nejvyšší soud ČSSR, ČSR, SSR), and lower courts'
 * it chose to publish. A post-1993 Supreme Court entry is a decision the
 * court's database (`cz-ns`) also holds; the entry adds what the database
 * does not state — the collection's number, part, year and issue, its edited
 * text and its own headnote. So the entry is one typed object under one
 * metadata key rather than loose keys: the `cz-ns-sbirka` adapter writes it on
 * the row it builds, and the step that attaches an entry to a decision another
 * source already holds reads the same object back.
 */
import * as v from "valibot";

import {
  CZ_NS_COLLECTION_PARTS,
  type CzNsCollectionPart,
} from "@stll/api-contract/cz-ns-collection-citation";
import type {
  MetadataUrlDefect,
  SafeHref,
} from "@stll/case-law-parsers/sanitize-url";

/** The metadata key the entry is stored under. */
export const CZ_NS_COLLECTION_METADATA_KEY = "czNsCollection";

/**
 * The `Druh` the collection states for each part. It prints its civil and
 * criminal parts as separate numbered series; `Stanoviska` and an absent
 * `Druh` name neither.
 */
const CZ_NS_COLLECTION_KIND_OF_PART = {
  civil: "Rozhodnutí ve věcech občanskoprávních, obchodních a správních",
  criminal: "Rozhodnutí ve věcech trestních",
} as const satisfies Record<CzNsCollectionPart, string>;

/** The part a stated `Druh` names, or null where it names neither. */
export const czNsCollectionPartOfKind = (
  kind: string | null,
): CzNsCollectionPart | null =>
  CZ_NS_COLLECTION_PARTS.find(
    (part) => CZ_NS_COLLECTION_KIND_OF_PART[part] === kind,
  ) ?? null;

const blockIndex = v.pipe(v.number(), v.integer(), v.minValue(0));
const sectionEditionSchema = v.object({
  extent: v.literal("section"),
  number: v.string(),
  sectionPart: v.object({
    sectionNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    firstBlock: blockIndex,
    afterLastBlock: blockIndex,
    collectionLabel: v.string(),
  }),
});

const reportEditionSchema = v.variant("extent", [
  sectionEditionSchema,
  v.object({ extent: v.literal("complete") }),
]);
export type CzNsReportEdition = v.InferOutput<typeof reportEditionSchema>;

/** A URL as the entry carries it once built: typed, or the defect found. */
type EntryUrl = SafeHref | MetadataUrlDefect | undefined;

/**
 * One collection entry. Every field is the publisher's statement as printed,
 * read from the entry's detail page; nothing is derived except `part`, which
 * names the series `kind` states.
 */
export type CzNsCollectionEntry<Url = EntryUrl> = {
  /** The WordPress post id the entry's page is addressed by. */
  readonly postId: string;
  /** The page's own heading: type, court, date, docket and, where stated, ECLI. */
  readonly title: string;
  /** Block offsets address the original edition, including its publisher heading. */
  readonly reportEdition?: CzNsReportEdition;
  /** `Druh`, as stated. */
  readonly kind: string | null;
  /** The series `kind` names; null where it names neither part. */
  readonly part: CzNsCollectionPart | null;
  /**
   * `Číslo rozhodnutí`, as stated. Text, because the collection numbers some
   * entries outside its series in Roman numerals (`II`).
   */
  readonly number: string | null;
  /** `Rok`, the collection year (ročník), not the decision's year. */
  readonly year: number | null;
  /** `Sešit`, the issue, as stated: `1`, `1-2`, `9-10`. */
  readonly issue: string | null;
  /** `Právní věta`, the collection's headnote, as stated. */
  readonly legalSentence: string | null;
  /** `Heslo`, one entry per keyword the publisher lists. */
  readonly keywords: readonly string[];
  /** `Předpisy`, one entry per line the publisher prints. */
  readonly citedProvisions: readonly string[];
  /**
   * `Dotčená rozhodnutí`, one entry per decision the page names: the earlier
   * collection entries this one bears on, as the publisher words them.
   */
  readonly affectedDecisions: readonly string[];
  /** `Ústavní stížnost`, the constitutional complaint lodged, as stated. */
  readonly constitutionalComplaint: string | null;
  /**
   * `Soud`, as stated. The publisher notes that it normalises court names for
   * search, so this can differ from the printed collection and from the title.
   */
  readonly statedCourt: string | null;
  /** The collection's renderings of the same entry, as the page links them. */
  readonly exports: { readonly pdf: Url; readonly epub: Url };
};

const nullableString = v.nullable(v.string());

/** The entry as a stored row reads back: URLs are plain strings in JSON. */
/** The stored entry's shape, which the attach step validates a record's metadata by. */
export const storedCzNsCollectionEntrySchema = v.object({
  postId: v.string(),
  title: v.string(),
  reportEdition: v.exactOptional(reportEditionSchema),
  kind: nullableString,
  part: v.nullable(v.picklist(CZ_NS_COLLECTION_PARTS)),
  number: nullableString,
  year: v.nullable(v.pipe(v.number(), v.integer())),
  issue: nullableString,
  legalSentence: nullableString,
  keywords: v.array(v.string()),
  citedProvisions: v.array(v.string()),
  affectedDecisions: v.array(v.string()),
  constitutionalComplaint: nullableString,
  statedCourt: nullableString,
  exports: v.object({
    pdf: v.optional(v.string()),
    epub: v.optional(v.string()),
  }),
});

export type StoredCzNsCollectionEntry = CzNsCollectionEntry<string | undefined>;

/**
 * The entry a stored row's metadata holds, or null where it holds none or one
 * of another shape.
 */
export const readStoredCzNsCollectionEntry = (
  metadata: Readonly<Record<string, unknown>>,
): StoredCzNsCollectionEntry | null => {
  const parsed = v.safeParse(
    storedCzNsCollectionEntrySchema,
    metadata[CZ_NS_COLLECTION_METADATA_KEY],
  );
  return parsed.success
    ? {
        ...parsed.output,
        exports: {
          pdf: parsed.output.exports.pdf,
          epub: parsed.output.exports.epub,
        },
      }
    : null;
};

/** Convert the publisher's edition statement to the attachment's body descriptor. */
export const czNsCollectionDocumentPartSchema = v.pipe(
  storedCzNsCollectionEntrySchema,
  v.transform(({ reportEdition, legalSentence, keywords }) => {
    const fields = { legalSentence, keywords: [...keywords] };
    switch (reportEdition?.extent) {
      case "section":
        return {
          extent: "section",
          ...reportEdition.sectionPart,
          ...fields,
        } as const;
      case "complete":
        return { extent: "complete", ...fields } as const;
      case undefined:
        return { extent: "unclassified", ...fields } as const;
      default:
        reportEdition satisfies never;
        return panic("Unhandled collection report edition");
    }
  }),
);

/** URL fields of the entry, for the metadata URL contract. */
export const CZ_NS_COLLECTION_METADATA_URL_SCHEMA = {
  [CZ_NS_COLLECTION_METADATA_KEY]: { exports: { pdf: "url", epub: "url" } },
} as const;
