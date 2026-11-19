/**
 * Anonymisation of insolvency-register documents before anything is stored.
 *
 * The register publishes court decisions as filed: unlike the courts' own
 * decision databases, nothing in them is anonymised. Parties who are natural
 * persons (debtors, creditors, their representatives) appear with names,
 * birth dates, birth numbers and addresses. The adapter therefore never hands
 * a document's text to the pipeline: it hands this module's output, and the
 * stored raw payload is that output too. A document this module cannot
 * anonymise with confidence is not stored at all.
 *
 * The detection is stella's own deterministic pipeline (`@stll/anonymize`,
 * the engine behind chat and MCP anonymisation), configured for a court
 * decision rather than for a chat message:
 *
 * - kept, because a decision is unreadable without them and they identify no
 *   natural person on their own: dates, amounts, countries, organisations
 *   (courts, companies, authorities) and case numbers;
 * - replaced with a numbered placeholder (`[PERSON_1]`): every other label the
 *   pipeline detects, persons and addresses, birth numbers and dates of birth,
 *   registration, account, card and document numbers, e-mail addresses and
 *   phone numbers, land parcels;
 * - protected before detection: court dockets (`3 VSPH 1361/2023-B-24`,
 *   `MSPH 60 INS 10782/2023`) are swapped for opaque markers, which the
 *   pipeline never reads as a hit, and restored afterwards, since the
 *   pipeline otherwise reads parts of them as registration numbers;
 * - added as detections of our own: a date written after "narozen", "nar."
 *   or "datum narození" is a date of birth even where the pipeline reads it
 *   as a date, which is kept;
 * - swept: every word of a detected person's name is redacted wherever else
 *   it stands, in any Czech case form, so a surname the pipeline found once
 *   cannot survive where a line or page break cut it off from the first name.
 *
 * Then the output is checked, and fails closed: a birth number shape, a date
 * still standing after a birth trigger, or a detected name's word still in
 * the text rejects the document.
 */
import { panic, Result, TaggedError } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import type {
  NativeCallerDetection,
  NativePipelineEntity,
  PreparedNativePipeline,
} from "@stll/anonymize";
import { declareFingerprintFields } from "@stll/errors";
import { normalizeUnicode } from "@stll/text-normalize";

import type { CzIsirParagraph } from "@/api/handlers/case-law/ingestion/parsers/cz-isir";
import { isRecord } from "@/api/lib/type-guards";

export class CzIsirAnonymizationError extends TaggedError(
  "CzIsirAnonymizationError",
)<{
  message: string;
  /** What the check found, never the text it found. */
  reason: CzIsirAnonymizationFailure;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

export const CZ_ISIR_ANONYMIZATION_FAILURE = {
  /** A paragraph or docket marker did not survive the pipeline intact. */
  STRUCTURE_LOST: "structure-lost",
  /** A birth number shape is still in the text. */
  BIRTH_NUMBER_LEFT: "birth-number-left",
  /** A date still follows a birth trigger. */
  BIRTH_DATE_LEFT: "birth-date-left",
  /** A word of a detected person's name is still in the text. */
  NAME_LEFT: "name-left",
  /** A residence trigger is still followed by an address. */
  RESIDENCE_LEFT: "residence-left",
} as const;

export type CzIsirAnonymizationFailure =
  (typeof CZ_ISIR_ANONYMIZATION_FAILURE)[keyof typeof CZ_ISIR_ANONYMIZATION_FAILURE];

/** The labels a decision keeps; every other detected label is replaced. */
const KEPT_LABELS = [
  "organization",
  "date",
  "monetary amount",
  "country",
  "case number",
] as const;

const OPERATORS = {
  operators: Object.fromEntries(
    KEPT_LABELS.map((label) => [label, "keep" as const]),
  ),
};

const PROVIDER_ID = "stella.cz-isir";
const PERSON_LABEL = "person";
const DATE_OF_BIRTH_LABEL = "date of birth";
const ADDRESS_LABEL = "address";

/**
 * Czech dockets: an insolvency file with its court (`MSPH 60 INS 10782/2023`,
 * `KSUL 74 INS 12709/2022-B-11`), a senate mark (`3 VSPH 1361/2023-B-24`,
 * `29 NSČR 45/2010`, `24 ICm 2849/2023-78`, `8 C 186/2018`) and a
 * Constitutional Court mark (`II. ÚS 563/03`, `Pl. ÚS 2/19`), with a sheet.
 */
const DOCKET =
  /(?:\b(?:[KMOV]S[A-Z]{1,3} )?\d{1,4} ?\p{Lu}[\p{L}]{0,5} \d{1,7}\/\d{2,4}|\b(?:Pl|[IV]{1,3})\. ?ÚS \d{1,5}\/\d{2,4})(?: ?- ?(?:[A-Z]{1,3}-)?\d{1,5})?/gu;

const MARKER = (index: number) => `⟦D${index}⟧`;
const MARKER_PATTERN = /⟦D(\d+)⟧/gu;

const BIRTH_TRIGGER = String.raw`\b(?:narozen[áéýo]?|nar\.|datum narození:?|r\. ?č\.:?)`;
/** `21. 5. 1980`, `1. ledna 1990`, `1980-05-21`. */
const DATE_VALUE = String.raw`\d{1,2}\. ?\d{1,2}\. ?\d{4}|\d{1,2}\. ?\p{Ll}+ \d{4}|\d{4}-\d{2}-\d{2}`;

/** A date after a birth trigger: `narozený 21. 5. 1980`, `nar. 1. ledna 1990`. */
const BIRTH_DATE = new RegExp(
  `(?<trigger>${BIRTH_TRIGGER}\\s*)(?<date>${DATE_VALUE})`,
  "giu",
);

/**
 * A paragraph that ends on a birth trigger, and the date that opens the next
 * one: a line break or an indent splits `narozený` from its date.
 */
const ENDS_ON_BIRTH_TRIGGER = new RegExp(`${BIRTH_TRIGGER}\\s*$`, "iu");
const LEADING_DATE = new RegExp(`^(?<date>${DATE_VALUE})`, "iu");

/** Czech and Slovak birth numbers with their slash: `900101/2020`. */
const BIRTH_NUMBER = /(?<![\d/])\d{6} ?\/ ?\d{3,4}(?![\d/])/u;

/**
 * A birth number without its slash, after the label that names it (`r. č.
 * 9001012020`, `rodné číslo: 9001012020`); unlabelled, ten digits are as
 * likely an account or a file number.
 */
const LABELLED_BIRTH_NUMBER =
  /(?:\br\. ?č\.|\brodn\p{Ll}* čísl\p{Ll}*|\bRČ)\s*:?\s*\d{6} ?\d{3,4}(?!\d)/iu;

const WORD = /\p{L}[\p{L}'’-]*/gu;
const PLACEHOLDER = /\[[A-Z_]+_\d+\]/gu;

/** Academic and professional titles, which name nobody. */
const TITLES: ReadonlySet<string> = new Set([
  "mgr",
  "judr",
  "ing",
  "bc",
  "phdr",
  "rndr",
  "mudr",
  "mvdr",
  "paeddr",
  "doc",
  "prof",
  "phd",
  "csc",
  "drsc",
  "llm",
  "mba",
  "dis",
  "arch",
  "dr",
  "ll",
  "m",
]);

/** Name words shorter than this match only exactly; shorter stems over-reach. */
const MIN_STEM = 4;

/** A detected name word this long is swept: `Jan` too, though only exactly. */
const MIN_NAME_WORD = 2;

/**
 * Czech case endings stripped off a name word to reach its stem, longest
 * first: `Vomáčková` and `Vomáčkové` share `Vomáčk`, `Novák` and `Nováka`
 * share `Novák`.
 */
const CASE_ENDINGS = [
  "ovou",
  "ové",
  "ová",
  "ovi",
  "ého",
  "ému",
  "ými",
  "em",
  "ou",
  "ům",
  "y",
  "ě",
  "e",
  "a",
  "u",
  "i",
  "í",
  "á",
  "ý",
  "o",
] as const;

const fold = (word: string): string =>
  normalizeUnicode(word, "NFC").toLocaleLowerCase("cs");

/**
 * A Czech name's fleeting `e`: `Mašek` declines as `Maška`, `Chovanec` as
 * `Chovance`; the stem drops it so every form shares one.
 */
const FLEETING_E = /e(?<consonant>[bcčdďfghjklmnňpqrřsštťvwxzž])$/u;

const stemOf = (word: string): string => {
  const folded = fold(word);
  let stem = folded;
  for (const ending of CASE_ENDINGS) {
    if (folded.endsWith(ending) && folded.length - ending.length >= MIN_STEM) {
      stem = folded.slice(0, -ending.length);
      break;
    }
  }
  return stem.length > MIN_STEM
    ? stem.replace(FLEETING_E, "$<consonant>")
    : stem;
};

const isCapitalised = (word: string): boolean => /^\p{Lu}/u.test(word);

/** The words of the detected persons' names that name somebody. */
const nameStems = (entities: readonly NativePipelineEntity[]): Set<string> => {
  const stems = new Set<string>();
  for (const entity of entities) {
    if (entity.label !== PERSON_LABEL) {
      continue;
    }
    for (const [word] of entity.text.matchAll(WORD)) {
      const folded = fold(word).replaceAll(".", "");
      if (
        isCapitalised(word) &&
        !TITLES.has(folded) &&
        folded.length >= MIN_NAME_WORD
      ) {
        stems.add(stemOf(word));
      }
    }
  }
  return stems;
};

/**
 * A name a document itself marks as a natural person's: up to five
 * capitalised words (titles included) followed by a birth date, a birth
 * number or a residence, as a party block states one (`Pavel Vomáčka,
 * narozený 21. 5. 1980`, `dlužnice: Jana Nová, nar. …, bytem …`).
 */
const NATURAL_PERSON_MARK =
  /,?\s(?:narozen[áéýo]?\b|nar\.|r\. ?č\.|datum narození|bytem\b|trvale bytem\b|místem podnikání\b)/gu;

/** At most this many capitalised words before a mark name the person. */
const MARKED_NAME_WORDS = 5;

/** The name words of every natural person the text marks as one. */
const markedNameStems = (text: string): Set<string> => {
  const stems = new Set<string>();
  for (const mark of text.matchAll(NATURAL_PERSON_MARK)) {
    // The capitalised words standing right before the mark, nearest first.
    const before = text.slice(0, mark.index).split(/\s/u).toReversed();
    for (const word of before.slice(0, MARKED_NAME_WORDS)) {
      if (!isCapitalised(word)) {
        break;
      }
      const folded = fold(word).replaceAll(".", "");
      if (!TITLES.has(folded) && folded.length >= MIN_NAME_WORD) {
        stems.add(stemOf(word.replaceAll(/[^\p{L}'’-]/gu, "")));
      }
    }
  }
  return stems;
};

/**
 * A representative named after the word that introduces one (`zastoupený
 * advokátem JUDr. Janem Novákem`): the party block prints the name after its
 * role, and a long address before it can hide the name from the pipeline.
 */
const INTRODUCED_PERSON =
  /\b(?:advokát(?:em|kou|ka|a|ovi)?|zástupc(?:em|e)|opatrovník(?:em)?|jednatel(?:em|ka|kou)?|správc(?:em|e)?|insolvenční(?:m)? správc(?:em|e))\s+(?<name>(?:(?:Mgr|JUDr|Ing|Bc|PhDr|RNDr|MUDr|doc|prof)\.\s*)*\p{Lu}\p{Ll}[\p{L}'’-]*(?:\s+\p{Lu}\p{Ll}[\p{L}'’-]*){1,2})/gu;

const introducedNameStems = (text: string): Set<string> => {
  const stems = new Set<string>();
  for (const match of text.matchAll(INTRODUCED_PERSON)) {
    for (const [word] of (match.groups?.["name"] ?? "").matchAll(WORD)) {
      const folded = fold(word).replaceAll(".", "");
      if (!TITLES.has(folded) && folded.length >= MIN_NAME_WORD) {
        stems.add(stemOf(word));
      }
    }
  }
  return stems;
};

/**
 * A residence or place of business after the word that introduces it, up to
 * the postcode's town (`bytem Lom u Tachova 90, 347 01 Tachov`). The
 * pipeline's address detector reads most; a residence is what a natural
 * person's address is, so it is never left to the detector alone.
 */
const RESIDENCE_TRIGGER =
  "(?:trvale )?bytem|místem podnikání|s místem podnikání|adresou trvalého pobytu";
const RESIDENCE = new RegExp(
  String.raw`\b(?<trigger>${RESIDENCE_TRIGGER})\s+(?<address>[^;()]{1,160}?\b\d{3} ?\d{2}\s+\p{Lu}[\p{L}.-]*(?:\s+(?:nad|pod|u|v|na|ve)\s+\p{Lu}[\p{L}.-]*|\s+\d{1,2}|\s+-\s+\p{Lu}[\p{L}.-]*)*)`,
  "gu",
);

const residenceSpans = (text: string) =>
  [...text.matchAll(RESIDENCE)].flatMap((match) => {
    const trigger = match.groups?.["trigger"];
    const address = match.groups?.["address"];
    if (trigger === undefined || address === undefined) {
      return [];
    }
    const start = match.index + match[0].length - address.length;
    return [{ start, end: start + address.length }];
  });

/**
 * A residence trigger still followed by a name rather than a placeholder:
 * an address the pipeline missed and {@link RESIDENCE} could not bound.
 */
const RESIDENCE_LEFT = new RegExp(
  String.raw`\b(?:${RESIDENCE_TRIGGER})\s+(?!\[[A-Z_]+_\d+\])\p{Lu}`,
  "u",
);

/** Capitalised words of `text` whose stem is a detected name's. */
const nameWordSpans = (
  text: string,
  stems: ReadonlySet<string>,
): { start: number; end: number }[] =>
  [...text.matchAll(WORD)].flatMap((match) =>
    isCapitalised(match[0]) && stems.has(stemOf(match[0]))
      ? [{ start: match.index, end: match.index + match[0].length }]
      : [],
  );

const detection = (
  span: { start: number; end: number },
  label: string,
  index: number,
): NativeCallerDetection => ({
  start: span.start,
  end: span.end,
  label,
  score: 1,
  providerId: PROVIDER_ID,
  detectionId: `${label.replaceAll(" ", "-")}-${index}`,
});

const birthDateSpans = (text: string) =>
  [...text.matchAll(BIRTH_DATE)].flatMap((match) => {
    const date = match.groups?.["date"];
    const trigger = match.groups?.["trigger"];
    if (date === undefined || trigger === undefined) {
      return [];
    }
    const start = match.index + trigger.length;
    return [{ start, end: start + date.length }];
  });

/**
 * A run of digits as its number. Every caller has matched the text against a
 * bounded digit pattern first, so a failed parse is an impossible state.
 */
const integerOf = (digits: string): number => {
  const parsed = parseIntegerToken(digits, { sign: "unsigned" });
  return Result.isOk(parsed)
    ? parsed.value
    : panic(`validated digits did not parse: ${digits}`);
};

const failure = (reason: CzIsirAnonymizationFailure, message: string) =>
  Result.err(new CzIsirAnonymizationError({ reason, message }));

/** A pipeline prepared once per process; see {@link createCzIsirAnonymizer}. */
export type CzIsirAnonymizer = {
  anonymize: (
    paragraphs: readonly CzIsirParagraph[],
  ) => Result<CzIsirParagraph[], CzIsirAnonymizationError>;
};

/**
 * The document's paragraphs with every natural person's identifying data
 * replaced, or the reason the document cannot be stored.
 */
const PLACEHOLDER_PARTS = /^\[(?<label>[A-Z_]+?)_(?<index>\d+)\]$/u;
const PERSON_PLACEHOLDER_LABEL = "PERSON";
const ADDRESS_PLACEHOLDER_LABEL = "ADDRESS";
const DATE_OF_BIRTH_PLACEHOLDER_LABEL = "DATE_OF_BIRTH";

/**
 * Placeholders numbered across the whole document. The pipeline numbers
 * each paragraph from one; the same person must read as the same
 * placeholder in every paragraph, and two people never as one.
 */
const createPlaceholderAllocator = () => {
  const byKey = new Map<string, string>();
  /** Every person placeholder a name word's stem has stood for. */
  const byStem = new Map<string, Set<string>>();
  /** The people of one surname stem: their first name's stem, and placeholder. */
  const bySurname = new Map<string, { given: string; placeholder: string }[]>();
  const counts = new Map<string, number>();
  const fresh = (label: string): string => {
    const next = (counts.get(label) ?? 0) + 1;
    counts.set(label, next);
    return `[${label}_${next}]`;
  };
  const remember = (words: readonly string[], placeholder: string) => {
    for (const word of words) {
      const stem = stemOf(word);
      const known = byStem.get(stem) ?? new Set<string>();
      known.add(placeholder);
      byStem.set(stem, known);
    }
  };
  const personWords = (original: string): string[] =>
    [...original.matchAll(WORD)].flatMap(([word]) => {
      const folded = fold(word).replaceAll(".", "");
      return isCapitalised(word) && !TITLES.has(folded) ? [word] : [];
    });
  /**
   * One first name in two case forms (`Jan`, `Janem`; `Pavel`, `Pavla`):
   * equal stems, or one stem and a case ending. `Martin` and `Marek` differ.
   */
  const sameGivenName = (a: string, b: string): boolean => {
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    return (
      shorter === longer ||
      (longer.startsWith(shorter) &&
        CASE_ENDINGS.some((ending) => ending === longer.slice(shorter.length)))
    );
  };
  /**
   * A person by surname and first name: Czech declension changes both
   * (`Pavel Vomáčka`, `Pavla Vomáčky`), their stems survive it, and two
   * people of one family keep two placeholders. A mention that could be
   * either of two people gets a placeholder of its own.
   */
  const person = (original: string): string => {
    const words = personWords(original);
    const surname = words.at(-1);
    const given = words.length > 1 ? words[0] : undefined;
    if (surname === undefined) {
      return fresh(PERSON_PLACEHOLDER_LABEL);
    }
    if (given === undefined) {
      const known = byStem.get(stemOf(surname));
      if (known === undefined) {
        const placeholder = fresh(PERSON_PLACEHOLDER_LABEL);
        remember(words, placeholder);
        return placeholder;
      }
      const [only] = known;
      return known.size === 1 && only !== undefined
        ? only
        : fresh(PERSON_PLACEHOLDER_LABEL);
    }
    const surnameStem = stemOf(surname);
    const givenStem = stemOf(given);
    const people = bySurname.get(surnameStem) ?? [];
    const matches = people.filter((known) =>
      sameGivenName(known.given, givenStem),
    );
    const [match] = matches;
    if (matches.length > 1) {
      return fresh(PERSON_PLACEHOLDER_LABEL);
    }
    const placeholder = match?.placeholder ?? fresh(PERSON_PLACEHOLDER_LABEL);
    if (match === undefined) {
      people.push({ given: givenStem, placeholder });
      bySurname.set(surnameStem, people);
    }
    remember(words, placeholder);
    return placeholder;
  };
  return {
    /** The document's placeholder for what the pipeline replaced. */
    of: (label: string, original: string): string => {
      if (label === PERSON_PLACEHOLDER_LABEL) {
        return person(original);
      }
      const key = `${label}\u0000${fold(original.replaceAll(/\s+/gu, " "))}`;
      const known = byKey.get(key);
      if (known !== undefined) {
        return known;
      }
      const placeholder = fresh(label);
      byKey.set(key, placeholder);
      return placeholder;
    },
  };
};

/**
 * The document's paragraphs with every natural person's identifying data
 * replaced, or the reason the document cannot be stored.
 *
 * Paragraph by paragraph, so no replaced span can run across a paragraph
 * boundary; the names found anywhere are swept everywhere.
 */
export const anonymizeCzIsirParagraphs = (
  pipeline: Pick<
    PreparedNativePipeline,
    "redactText" | "redactTextWithCallerDetections"
  >,
  paragraphs: readonly CzIsirParagraph[],
): Result<CzIsirParagraph[], CzIsirAnonymizationError> => {
  const masked = paragraphs.map(({ text }) => {
    const dockets: string[] = [];
    const protectedText = text
      .replaceAll(/\s+/gu, " ")
      .trim()
      .replaceAll(DOCKET, (docket) => {
        dockets.push(docket);
        return MARKER(dockets.length - 1);
      });
    return { text: protectedText, dockets };
  });
  const stems = new Set<string>();
  for (const { text } of masked) {
    const found = pipeline.redactText(text, OPERATORS);
    for (const stem of nameStems(found.resolvedEntities)) {
      stems.add(stem);
    }
    for (const stem of markedNameStems(text)) {
      stems.add(stem);
    }
    for (const stem of introducedNameStems(text)) {
      stems.add(stem);
    }
  }

  const placeholders = createPlaceholderAllocator();
  const out: CzIsirParagraph[] = [];
  for (const [position, { text, dockets }] of masked.entries()) {
    const afterBirthTrigger = ENDS_ON_BIRTH_TRIGGER.test(
      masked[position - 1]?.text ?? "",
    );
    const leadingBirthDate = afterBirthTrigger
      ? LEADING_DATE.exec(text)?.groups?.["date"]
      : undefined;
    const birthDates = [
      ...(leadingBirthDate === undefined
        ? []
        : [{ start: 0, end: leadingBirthDate.length }]),
      ...birthDateSpans(text),
    ];
    const detections = [
      ...birthDates.map((span, index) =>
        detection(span, DATE_OF_BIRTH_LABEL, index),
      ),
      ...nameWordSpans(text, stems).map((span, index) =>
        detection(span, PERSON_LABEL, index),
      ),
      ...residenceSpans(text).map((span, index) =>
        detection(span, ADDRESS_LABEL, index),
      ),
    ];
    const { redactedText, redactionMap } =
      pipeline.redactTextWithCallerDetections(text, {
        detections,
        operators: OPERATORS,
      }).redaction;
    const renumbered = redactedText.replaceAll(PLACEHOLDER, (placeholder) => {
      const label = PLACEHOLDER_PARTS.exec(placeholder)?.groups?.["label"];
      const original = redactionMap.get(placeholder);
      return label === undefined || original === undefined
        ? placeholder
        : placeholders.of(label, original);
    });
    // A residence or a birth date inside a span the pipeline kept whole (an
    // organisation it read too widely) is still standing verbatim; it is
    // replaced here, outside the pipeline, and so is a name word.
    const kept = (
      afterBirthTrigger
        ? renumbered.replace(LEADING_DATE, (born) =>
            placeholders.of(DATE_OF_BIRTH_PLACEHOLDER_LABEL, born),
          )
        : renumbered
    )
      .replaceAll(RESIDENCE, (whole: string, ...rest: unknown[]) => {
        const groups = rest.at(-1);
        const address =
          isRecord(groups) && typeof groups["address"] === "string"
            ? groups["address"]
            : undefined;
        return address === undefined
          ? whole
          : `${whole.slice(0, whole.length - address.length)}${placeholders.of(ADDRESS_PLACEHOLDER_LABEL, address)}`;
      })
      .replaceAll(BIRTH_DATE, (whole: string, ...rest: unknown[]) => {
        const groups = rest.at(-1);
        const born =
          isRecord(groups) && typeof groups["date"] === "string"
            ? groups["date"]
            : undefined;
        return born === undefined
          ? whole
          : `${whole.slice(0, whole.length - born.length)}${placeholders.of(DATE_OF_BIRTH_PLACEHOLDER_LABEL, born)}`;
      });
    const swept = kept.replaceAll(WORD, (word) =>
      isCapitalised(word) && stems.has(stemOf(word))
        ? placeholders.of(PERSON_PLACEHOLDER_LABEL, word)
        : word,
    );
    // Every docket must come back, once and in order: a marker a replaced
    // span took with it would drop the docket from the decision.
    const markers = [...swept.matchAll(MARKER_PATTERN)].map((match) =>
      integerOf(match[1] ?? ""),
    );
    if (
      markers.length !== dockets.length ||
      markers.some((index, at) => index !== at)
    ) {
      return failure(
        CZ_ISIR_ANONYMIZATION_FAILURE.STRUCTURE_LOST,
        "A docket marker did not survive anonymisation",
      );
    }
    const restored = swept.replaceAll(
      MARKER_PATTERN,
      (_, index: string) => dockets[integerOf(index)] ?? "",
    );
    // The checks read the text outside placeholders and dockets only.
    const residue = restored
      .replaceAll(PLACEHOLDER, " ")
      .replaceAll(DOCKET, " ");
    if (BIRTH_NUMBER.test(residue) || LABELLED_BIRTH_NUMBER.test(residue)) {
      return failure(
        CZ_ISIR_ANONYMIZATION_FAILURE.BIRTH_NUMBER_LEFT,
        "A birth number survived anonymisation",
      );
    }
    if (
      birthDateSpans(residue).length > 0 ||
      (afterBirthTrigger && LEADING_DATE.test(residue.trimStart()))
    ) {
      return failure(
        CZ_ISIR_ANONYMIZATION_FAILURE.BIRTH_DATE_LEFT,
        "A date of birth survived anonymisation",
      );
    }
    // Read where placeholders still stand: a residence must be one.
    if (RESIDENCE_LEFT.test(restored)) {
      return failure(
        CZ_ISIR_ANONYMIZATION_FAILURE.RESIDENCE_LEFT,
        "A residence survived anonymisation",
      );
    }
    if (nameWordSpans(residue, stems).length > 0) {
      return failure(
        CZ_ISIR_ANONYMIZATION_FAILURE.NAME_LEFT,
        "A word of a detected name survived anonymisation",
      );
    }
    out.push({ text: restored, bold: paragraphs[position]?.bold ?? false });
  }
  return Result.ok(out);
};

/**
 * The anonymiser the adapter runs: the Czech pipeline, prepared on first use
 * and reused, since preparing it is the expensive step.
 */
export const createCzIsirAnonymizer = (
  prepare: () => Promise<
    Pick<
      PreparedNativePipeline,
      "redactText" | "redactTextWithCallerDetections"
    >
  >,
): { load: () => Promise<CzIsirAnonymizer> } => {
  let prepared: ReturnType<typeof prepare> | null = null;
  return {
    load: async () => {
      prepared ??= prepare();
      const attempt = prepared;
      // A failed preparation is not kept: the next load prepares again.
      const pipeline = await attempt.catch((error: unknown) => {
        if (prepared === attempt) {
          prepared = null;
        }
        throw error;
      });
      return {
        anonymize: (paragraphs) =>
          anonymizeCzIsirParagraphs(pipeline, paragraphs),
      };
    },
  };
};
