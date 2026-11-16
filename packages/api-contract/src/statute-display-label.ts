import { statuteActLabel } from "./statute-act-number";
import type { StatuteQueryCountry } from "./statute-query-capability";

/** Citation words belong to the act's language, independently of the UI locale. */
const CITATION_STYLE = {
  cze: { numberPrefix: "č.", subjectSeparator: ", " },
  svk: { numberPrefix: "č.", subjectSeparator: " " },
} as const satisfies Record<
  StatuteQueryCountry,
  { numberPrefix: string; subjectSeparator: string }
>;

type StatuteDisplayLabelInput = {
  country: string;
  eli: string;
  title: string;
  /** The publisher's act type, in its source language; absent stays absent. */
  documentType?: string | null;
};

/** Keep identity separate so constrained surfaces can shorten only the subject. */
export const statuteDisplayLabel = ({
  country,
  eli,
  title,
  documentType,
}: StatuteDisplayLabelInput) => {
  const jurisdiction = country.toLowerCase();
  if (jurisdiction !== "cze" && jurisdiction !== "svk") {
    return { identity: null, subject: title, text: title };
  }

  const style = CITATION_STYLE[jurisdiction];
  const { number, name } = statuteActLabel({ eli, title });
  const sourceType = documentType?.trim() ?? "";
  const type =
    sourceType
      .charAt(0)
      .toLocaleUpperCase(jurisdiction === "cze" ? "cs" : "sk") +
    sourceType.slice(1);
  let identity = type || null;
  if (number !== null) {
    identity = type === "" ? number : `${type} ${style.numberPrefix} ${number}`;
  }
  const subject = number === null ? title.trim() || null : name;
  let text = subject ?? "";
  if (identity !== null) {
    text =
      subject === null
        ? identity
        : `${identity}${style.subjectSeparator}${subject}`;
  }
  return { identity, subject, text };
};
