/** `…/eli/<country>/<collection>/<year>/<number>`, optionally with a tail. */
const STATUTE_ELI_IDENTITY_PATTERN = String.raw`\/eli\/[a-z]{2}\/([a-z0-9]+)\/([0-9]{4})\/([0-9]{1,5})(?:\/|$)`;

const STATUTE_ELI_IDENTITY_RE = new RegExp(STATUTE_ELI_IDENTITY_PATTERN, "u");

export const parseStatuteEliIdentity = (eli: string | null | undefined) => {
  const match =
    eli === null || eli === undefined
      ? null
      : STATUTE_ELI_IDENTITY_RE.exec(eli);
  const ordinal = match?.[3];
  return {
    collection: match?.[1] ?? null,
    number: ordinal === undefined ? null : String(Number(ordinal)),
    year: match?.[2] ?? null,
  };
};

/** The caller validates the year as four digits at its input boundary. */
export const statuteEliYearPattern = (year: string) =>
  STATUTE_ELI_IDENTITY_PATTERN.replace("[0-9]{4}", () => year);
