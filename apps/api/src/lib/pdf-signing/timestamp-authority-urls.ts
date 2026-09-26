/**
 * The ordered timestamp authorities PDF signing may use.
 *
 * `PDF_SIGNING_TSA_URLS` lists them in preference order, separated by commas
 * or whitespace; the older single `PDF_SIGNING_TSA_URL` is still read and
 * joins the end of the list. Kept free of runtime imports so the env schema
 * can validate with the same parser the signer reads with.
 */

const LIST_SEPARATOR = /[\s,]+/u;

const isTimestampAuthorityUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

const splitList = (value: string | undefined) =>
  (value ?? "").split(LIST_SEPARATOR).filter((entry) => entry !== "");

/** Env-schema check: every listed entry is an http(s) URL. */
export const isTimestampAuthorityUrlList = (value: string) =>
  splitList(value).every(isTimestampAuthorityUrl);

export const parseTimestampAuthorityUrls = ({
  list,
  single,
}: {
  list: string | undefined;
  single: string | undefined;
}): string[] => [
  ...new Set(
    [...splitList(list), ...splitList(single)].filter(isTimestampAuthorityUrl),
  ),
];
