import { panic } from "better-result";

/** Third-person and infinitive forms used at the opening of Polish rulings. */
type PolishVerbInflection =
  | "final-ć"
  | "ować-to-uje"
  | "ywać-to-uje"
  | "awać-to-aje"
  | "ąć-to-mie"
  | "zać-to-że"
  | "ść-to-sie"
  | "ec-to-eknie";

type PolishOperativeLemma = {
  readonly lemma: string;
  readonly inflection: PolishVerbInflection;
  readonly polarity?: "positive" | "both";
  readonly particle?: " się";
  readonly holdingHeading?: "bare" | "past";
};

type ReplaceEndingOptions = {
  word: string;
  ending: string;
  replacement: string;
};

const replaceEnding = ({
  word,
  ending,
  replacement,
}: ReplaceEndingOptions): string => {
  if (!word.endsWith(ending)) {
    return panic(`Operative verb does not end with ${ending}`);
  }
  return `${word.slice(0, -ending.length)}${replacement}`;
};

/**
 * Infinitives are the source of both infinitive and finite forms. Aspect
 * pairs stay separate because their finite forms and meanings differ.
 */
const POLISH_OPERATIVE_LEMMAS = [
  { lemma: "oddalać", inflection: "final-ć" },
  { lemma: "oddalić", inflection: "final-ć" },
  { lemma: "zmieniać", inflection: "final-ć" },
  { lemma: "zmienić", inflection: "final-ć" },
  { lemma: "uchylać", inflection: "final-ć" },
  { lemma: "uchylić", inflection: "final-ć" },
  { lemma: "zasądzać", inflection: "final-ć" },
  { lemma: "zasądzić", inflection: "final-ć" },
  { lemma: "stwierdzać", inflection: "final-ć" },
  { lemma: "stwierdzić", inflection: "final-ć" },
  { lemma: "umarzać", inflection: "final-ć" },
  { lemma: "umorzyć", inflection: "final-ć" },
  { lemma: "utrzymywać", inflection: "ywać-to-uje" },
  { lemma: "utrzymać", inflection: "final-ć" },
  { lemma: "nakazywać", inflection: "ywać-to-uje" },
  { lemma: "nakazać", inflection: "zać-to-że" },
  { lemma: "odrzucać", inflection: "final-ć" },
  { lemma: "odrzucić", inflection: "final-ć" },
  { lemma: "ustalać", inflection: "final-ć" },
  { lemma: "ustalić", inflection: "final-ć" },
  { lemma: "przyjmować", inflection: "ować-to-uje" },
  { lemma: "przyjąć", inflection: "ąć-to-mie" },
  { lemma: "przyznawać", inflection: "awać-to-aje" },
  { lemma: "przyznać", inflection: "final-ć" },
  { lemma: "odmawiać", inflection: "final-ć" },
  { lemma: "odmówić", inflection: "final-ć" },
  { lemma: "zwracać", inflection: "final-ć", particle: " się" },
  { lemma: "zwrócić", inflection: "final-ć", particle: " się" },
  { lemma: "przekazywać", inflection: "ywać-to-uje" },
  { lemma: "przekazać", inflection: "zać-to-że" },
  { lemma: "obciążać", inflection: "final-ć", polarity: "both" },
  { lemma: "obciążyć", inflection: "final-ć", polarity: "both" },
  { lemma: "znosić", inflection: "final-ć" },
  { lemma: "znieść", inflection: "ść-to-sie" },
  { lemma: "orzekać", inflection: "final-ć", holdingHeading: "bare" },
  { lemma: "orzec", inflection: "ec-to-eknie" },
  { lemma: "uznawać", inflection: "awać-to-aje" },
  { lemma: "uznać", inflection: "final-ć" },
  { lemma: "wymierzać", inflection: "final-ć" },
  { lemma: "wymierzyć", inflection: "final-ć" },
  { lemma: "zwalniać", inflection: "final-ć" },
  { lemma: "zwolnić", inflection: "final-ć" },
  { lemma: "zakazywać", inflection: "ywać-to-uje" },
  { lemma: "zakazać", inflection: "zać-to-że" },
  { lemma: "postanawiać", inflection: "final-ć", holdingHeading: "bare" },
  { lemma: "postanowić", inflection: "final-ć", holdingHeading: "past" },
  { lemma: "uchwalać", inflection: "final-ć", holdingHeading: "bare" },
  { lemma: "uchwalić", inflection: "final-ć", holdingHeading: "past" },
  { lemma: "zarządzać", inflection: "final-ć", holdingHeading: "bare" },
  { lemma: "zarządzić", inflection: "final-ć" },
] as const satisfies readonly PolishOperativeLemma[];

const finiteThirdPersonOf = ({
  lemma,
  inflection,
}: PolishOperativeLemma): string => {
  switch (inflection) {
    case "final-ć":
      return replaceEnding({ word: lemma, ending: "ć", replacement: "" });
    case "ować-to-uje":
      return replaceEnding({ word: lemma, ending: "ować", replacement: "uje" });
    case "ywać-to-uje":
      return replaceEnding({ word: lemma, ending: "ywać", replacement: "uje" });
    case "awać-to-aje":
      return replaceEnding({ word: lemma, ending: "awać", replacement: "aje" });
    case "ąć-to-mie":
      return replaceEnding({ word: lemma, ending: "ąć", replacement: "mie" });
    case "zać-to-że":
      return replaceEnding({ word: lemma, ending: "zać", replacement: "że" });
    case "ść-to-sie":
      return replaceEnding({ word: lemma, ending: "ść", replacement: "sie" });
    case "ec-to-eknie":
      return replaceEnding({ word: lemma, ending: "ec", replacement: "eknie" });
    default:
      inflection satisfies never;
      return panic("Unsupported Polish operative verb inflection");
  }
};

const formsOf = ({
  lemma,
  particle,
  inflection,
  polarity,
}: PolishOperativeLemma): string[] => {
  const finite = finiteThirdPersonOf({ lemma, inflection });
  const forms = [lemma, finite].flatMap((form) =>
    polarity === "both" ? [form, `nie ${form}`] : [form],
  );
  if (particle !== undefined) {
    forms.push(`${lemma}${particle}`, `${finite}${particle}`);
  }
  return forms;
};

const POLISH_OPERATIVE_FORMS = POLISH_OPERATIVE_LEMMAS.flatMap(
  formsOf,
).toSorted((left, right) => right.length - left.length);

const POLISH_OPERATIVE_START = new RegExp(
  `^(?:${POLISH_OPERATIVE_FORMS.join("|")})(?!\\p{L})`,
  "iu",
);

/** Whether text begins with a listed Polish operative verb form. */
export const startsWithPlOperativeVerb = (text: string): boolean =>
  POLISH_OPERATIVE_START.test(text.trimStart());

const holdingHeadingForms = POLISH_OPERATIVE_LEMMAS.flatMap((entry) => {
  if (!("holdingHeading" in entry)) {
    return [];
  }
  const forms = [entry.lemma, finiteThirdPersonOf(entry)];
  if (entry.holdingHeading === "past") {
    forms.push(
      replaceEnding({ word: entry.lemma, ending: "ć", replacement: "ł" }),
    );
  }
  return forms;
}).toSorted((left, right) => right.length - left.length);

const POLISH_HOLDING_HEADING = new RegExp(
  `^(?:${holdingHeadingForms.join("|")})(?:\\s*:\\s*)?$`,
  "iu",
);

/** Whether text is a bare Polish operative section heading. */
export const isPlHoldingHeading = (text: string): boolean =>
  POLISH_HOLDING_HEADING.test(text.trim());
