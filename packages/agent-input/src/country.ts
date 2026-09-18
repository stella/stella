/**
 * Countries on the agent wire.
 *
 * A corpus country is canonically ISO 3166-1 alpha-3 (`CZE`), but that is the
 * spelling a database column chose, not the one a model reaches for. Asked in
 * Czech for Czech case law, a model writes `CZ`, `Česko`, `Česká republika` or
 * `Czech Republic`, and every one of those carries exactly one meaning, so
 * every one of them is read.
 *
 * The names come from CLDR through `Intl.DisplayNames` rather than from a list
 * maintained here: the corpus serves several languages, and a hand-kept table
 * would hold whichever spellings someone thought of. CLDR holds every region's
 * name in every locale, which is why `Rakousko`, `Poľsko` and `Tschechien`
 * need no entry of their own. Only the official long forms CLDR omits
 * (`Česká republika` against its `Česko`) are declared below.
 *
 * What is NOT read: a token that carries two country readings. `CS` is the
 * ISO 639-1 code for the Czech language and was ISO 3166-1's code for
 * Czechoslovakia, whose law two of this corpus's jurisdictions inherited, so it
 * is asked about with both readings named. A token that is itself a valid
 * alpha-2 country code is not in that class: on a field whose name is
 * `country`, `SL` is Sierra Leone, and reading it as the Slovenian language tag
 * would be inventing an intent the field does not carry.
 *
 * Admission is a separate question and stays with the caller. This reader says
 * which country a spelling names; whether that country has a corpus is the
 * handler's `not_found`.
 */

import type { CountryAlpha3Code, CountryCode } from "@stll/country-codes";
import {
  COUNTRY_ALPHA3_BY_CODE,
  COUNTRY_CODES,
  countryCodeFromAlpha3,
  isCountryCode,
} from "@stll/country-codes";
import { foldToAscii } from "@stll/text-normalize";

import type { Normalized } from "./normalized";
import { askForFix, readValueAs } from "./normalized";

/**
 * Jurisdictions that publish law without being ISO 3166-1 countries.
 *
 * The EU is the one this corpus holds: the Court of Justice and the Official
 * Journal are supranational, and legal corpora and ELI identifiers spell that
 * jurisdiction `EU`. CLDR carries `EU` as a region, so its names arrive from
 * the same place as a country's, and ISO assigns it neither alpha-2 nor
 * alpha-3, so `EU` is both.
 */
const SUPRANATIONAL_CODES = ["EU"] as const;

type SupranationalCode = (typeof SUPRANATIONAL_CODES)[number];

/** A canonical alpha-3 code, or the supranational code ISO leaves unassigned. */
export type CountryAlpha3 = CountryAlpha3Code | SupranationalCode;

/** A canonical alpha-2 (CLDR region) code, or the supranational code. */
export type CountryAlpha2 = CountryCode | SupranationalCode;

/**
 * One country, in both spellings a consumer might store.
 *
 * Both are returned because both are canonical somewhere: the corpus keys on
 * alpha-3, and a practice-jurisdiction row and every CLDR lookup key on
 * alpha-2. A caller picks the one its column holds instead of converting.
 */
export type CountryValue = {
  readonly alpha3: CountryAlpha3;
  readonly alpha2: CountryAlpha2;
};

/**
 * The languages whose spellings are read.
 *
 * These are the languages this corpus's jurisdictions legislate and adjudicate
 * in, plus English, which every model falls back to. A locale added here widens
 * what is accepted and can only introduce an ambiguity that the index reports
 * rather than guesses.
 */
const NAME_LOCALES = ["en", "cs", "sk", "pl", "de", "hu"] as const;

/**
 * Official long forms CLDR does not carry, keyed by CLDR region.
 *
 * CLDR holds the short name a locale uses day to day (`Česko`, `Slovensko`),
 * while a model drafting a legal document reaches for the constitutional name.
 * Listed are the jurisdictions this corpus serves, plus Germany, whose language
 * the corpus serves and whose law gets asked about in it. Each entry is in
 * English or in one of those languages: an entry earns its place by being a
 * name some surface actually receives, not by completeness. Case, spacing and
 * diacritics need no entries of their own, because the index keys on the folded
 * form.
 */
const OFFICIAL_NAMES = {
  AT: ["Republic of Austria", "Republik Österreich", "Rakouská republika"],
  CZ: [
    "Czech Republic",
    "Česká republika",
    "Tschechische Republik",
    "Republika Czeska",
  ],
  DE: ["Federal Republic of Germany", "Bundesrepublik Deutschland"],
  // Hungary's constitutional name is `Magyarország`, which CLDR carries; what
  // it omits is the name the country bore until 2012, under which its older
  // law is still cited.
  HU: ["Republic of Hungary", "Magyar Köztársaság"],
  PL: ["Republic of Poland", "Rzeczpospolita Polska", "Polská republika"],
  SK: [
    "Slovak Republic",
    "Slovenská republika",
    "Slowakische Republik",
    "Republika Słowacka",
  ],
  // The pre-1993 name of the same jurisdiction, which CLDR does not carry.
  EU: ["European Communities"],
} as const satisfies Record<string, readonly string[]>;

/**
 * Tokens that name two countries at once.
 *
 * Each maps to the readings the ask must name. A token here must not be a valid
 * alpha-2 code: the codes are read as themselves, and this table exists for the
 * spellings that are not codes at all.
 */
const AMBIGUOUS_TOKENS: ReadonlyMap<string, readonly string[]> = new Map([
  ["cs", ["CZE", "SVK"]],
]);

/** The comparison form of a name: case, diacritics and spacing carry no
 *  meaning in a country name, so none of them reach the index key. */
const fold = (value: string): string =>
  foldToAscii(value.trim()).toLowerCase().replaceAll(/\s+/gu, " ");

type CountryIndex = {
  /** Folded name to the CLDR regions it names; more than one means ambiguous. */
  readonly regionsByName: ReadonlyMap<string, readonly string[]>;
};

/**
 * The name index, built once on first read.
 *
 * `Intl.DisplayNames` is thousands of lookups across every region and locale,
 * so it is deferred rather than run at import: a module that only ever reads a
 * code should not pay for the names, and a shared module must not do work when
 * it is loaded.
 */
let cachedIndex: CountryIndex | null = null;

const buildIndex = (): CountryIndex => {
  const regions: readonly string[] = [...COUNTRY_CODES, ...SUPRANATIONAL_CODES];
  const collected = new Map<string, string[]>();

  const add = (name: string, region: string): void => {
    const key = fold(name);
    if (key.length === 0) {
      return;
    }
    const existing = collected.get(key);
    if (existing === undefined) {
      collected.set(key, [region]);
      return;
    }
    if (!existing.includes(region)) {
      existing.push(region);
    }
  };

  for (const locale of NAME_LOCALES) {
    // `long` is the full name and `short` the abbreviation a locale actually
    // writes (`UK` for GB); `fallback: "none"` keeps a region CLDR cannot name
    // out of the index instead of indexing its own code as its name.
    for (const style of ["long", "short"] as const) {
      const display = new Intl.DisplayNames([locale], {
        type: "region",
        style,
        fallback: "none",
      });
      for (const region of regions) {
        const name = display.of(region);
        if (name !== undefined && name !== region) {
          add(name, region);
        }
      }
    }
  }

  for (const [region, names] of Object.entries(OFFICIAL_NAMES)) {
    for (const name of names) {
      add(name, region);
    }
  }

  return { regionsByName: collected };
};

const index = (): CountryIndex => {
  cachedIndex ??= buildIndex();
  return cachedIndex;
};

const isSupranational = (value: string): value is SupranationalCode =>
  SUPRANATIONAL_CODES.some((code) => code === value);

/** The canonical pair a CLDR region names. */
const valueOfRegion = (region: string): CountryValue | null => {
  if (isSupranational(region)) {
    return { alpha3: region, alpha2: region };
  }
  return isCountryCode(region)
    ? { alpha3: COUNTRY_ALPHA3_BY_CODE[region], alpha2: region }
    : null;
};

/** The canonical pair a code names, in either ISO length. */
const valueOfCode = (upper: string): CountryValue | null => {
  if (isSupranational(upper)) {
    return { alpha3: upper, alpha2: upper };
  }
  const fromAlpha3 = countryCodeFromAlpha3(upper);
  if (fromAlpha3 !== null) {
    return { alpha3: COUNTRY_ALPHA3_BY_CODE[fromAlpha3], alpha2: fromAlpha3 };
  }
  return isCountryCode(upper)
    ? { alpha3: COUNTRY_ALPHA3_BY_CODE[upper], alpha2: upper }
    : null;
};

/**
 * The longest country spelling a wire schema accepts.
 *
 * A country's own name is a spelling this reader reads, so the bound is a
 * name's length rather than a code's: `Federal Republic of Germany` is a
 * country input, and a schema capped at three characters was what turned it
 * into a rejection before the reader ever saw it. It lives with the reader so
 * the declared bound and what can be read cannot drift apart.
 */
export const COUNTRY_INPUT_MAX_CHARS = 64;

/** Which ISO spelling the calling surface stores. */
export type CountrySpelling = "alpha-3" | "alpha-2";

export type CountryOptions = {
  /** The spelling the caller keeps, which decides how a coercion is reported:
   *  a surface storing alpha-2 must not be told its `CZ` was read as `CZE`. */
  spelling?: CountrySpelling | undefined;
  /** The canonical codes the calling surface holds law for, named in the ask so
   *  a model that guessed wrong can see what there is to ask for. */
  admitted?: readonly string[] | undefined;
  /** The tool whose input this is, so the ask names the call to change. */
  tool?: string | undefined;
  /** The property name, which differs between surfaces (`country`,
   *  `country_code`). */
  parameter?: string | undefined;
};

const COUNTRY_EXPECTED = "a country";

/** The code a caller keeping `spelling` stores. */
export const countryCodeIn = (
  value: CountryValue,
  spelling: CountrySpelling = "alpha-3",
): string => (spelling === "alpha-2" ? value.alpha2 : value.alpha3);

/**
 * How the canonical value is quoted in a coercion note.
 *
 * The note compares against the spelling the agent sent, which is the quoted
 * JSON of a string, so the canonical code is quoted the same way. Without it,
 * `"CZE"` would be reported as read into `CZE` and a canonical input would not
 * be the fixed point it is.
 */
const canonicalSpelling = (
  value: CountryValue,
  options: CountryOptions,
): string => JSON.stringify(countryCodeIn(value, options.spelling));

const admittedSentence = (admitted: readonly string[] | undefined): string =>
  admitted === undefined || admitted.length === 0
    ? ""
    : ` Admitted: ${admitted.join(", ")}.`;

/** Where to make the correction, as far as the caller told us. */
const target = ({ tool, parameter }: CountryOptions): string => {
  const property = parameter ?? "country";
  return tool === undefined ? `\`${property}\`` : `\`${property}\` on ${tool}`;
};

const expectedWith = (options: CountryOptions): string => {
  const admitted = options.admitted;
  return admitted === undefined || admitted.length === 0
    ? COUNTRY_EXPECTED
    : `a country code, one of ${admitted.join(", ")}`;
};

/** The spellings the reader accepts, as one clause a hint drops in. */
const ACCEPTED_SPELLINGS =
  'an ISO 3166-1 code, alpha-3 or alpha-2 ("CZE", "CZ"); the country\'s name in English or in a language the corpus serves ("Czechia", "Česko", "Česká republika") is read as well.';

const spellingHint = (options: CountryOptions): string =>
  `Set ${target(options)} to ${ACCEPTED_SPELLINGS}${admittedSentence(options.admitted)}`;

/**
 * Read a country an agent spelled its own way.
 *
 * An absent value asks rather than defaulting: a corpus country decides which
 * body of law is searched, and picking one on the model's behalf answers a
 * question about Czech law with Slovak decisions.
 */
export const normalizeCountry = (
  input: unknown,
  options: CountryOptions = {},
): Normalized<CountryValue> => {
  const absent =
    input === undefined ||
    input === null ||
    (typeof input === "string" && input.trim().length === 0);
  if (absent) {
    return askForFix({
      input,
      expected: expectedWith(options),
      hint: `${target(options)} is required. ${spellingHint(options)}`,
    });
  }
  if (typeof input !== "string") {
    return askForFix({
      input,
      expected: expectedWith(options),
      hint: spellingHint(options),
    });
  }

  const collapsed = input.trim().replaceAll(/\s+/gu, " ");
  const byCode = valueOfCode(collapsed.toUpperCase());
  if (byCode !== null) {
    return readValueAs(input, byCode, canonicalSpelling(byCode, options));
  }

  const key = fold(collapsed);
  const ambiguous = AMBIGUOUS_TOKENS.get(key);
  if (ambiguous !== undefined) {
    return askForFix({
      input,
      expected: expectedWith(options),
      hint:
        `"${collapsed}" names more than one country here: ` +
        `${ambiguous.join(" or ")}. Set ${target(options)} to the one you ` +
        `mean.${admittedSentence(options.admitted)}`,
    });
  }

  const regions = index().regionsByName.get(key);
  const single = regions?.length === 1 ? regions.at(0) : undefined;
  if (single !== undefined) {
    const value = valueOfRegion(single);
    if (value !== null) {
      return readValueAs(input, value, canonicalSpelling(value, options));
    }
  }
  if (regions !== undefined && regions.length > 1) {
    const readings = regions
      .map((region) => valueOfRegion(region)?.alpha3)
      .filter((alpha3): alpha3 is CountryAlpha3 => alpha3 !== undefined);
    return askForFix({
      input,
      expected: expectedWith(options),
      hint:
        `"${collapsed}" names more than one country here: ` +
        `${readings.join(" or ")}. Set ${target(options)} to the one you ` +
        `mean.${admittedSentence(options.admitted)}`,
    });
  }

  return askForFix({
    input,
    expected: expectedWith(options),
    hint: spellingHint(options),
  });
};
