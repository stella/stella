/**
 * The DOS code page that settles a tie between readings of the file names a
 * ZIP archive stores without its UTF-8 flag (`decodeUndeclaredFileNames`).
 *
 * Windows writes such names in its OEM code page: 852 on Czech, Slovak,
 * Polish and Hungarian Windows, 437 on English and Western European Windows.
 * Most names hold a letter that tells the two apart; a name that does not
 * (`ů` in 852 is the byte of `à` in 437) is read in the code page the
 * organization's archives most likely come from: 852 when its practice
 * jurisdictions include one of those four countries, else 437, the ZIP
 * specification's.
 *
 * Archives are read in the extraction worker. The API derives the code page
 * where it hands a file to the worker and passes it in
 * `ZIP_NAME_CODE_PAGE_ENV`, the same way for every worker mode: each mode
 * takes positional arguments of its own, and a ZIP can sit anywhere inside
 * what a mode reads (an email's attachment, a mailbox's message, a signed
 * container's document), so one value for the whole run reaches every
 * archive the run opens.
 */
import { panic } from "better-result";

import type { FileNameCharset } from "@stll/mojibake/undeclared-charset";

export const ZIP_NAME_CODE_PAGES = [
  "ibm437",
  "ibm852",
] as const satisfies readonly FileNameCharset[];

export type ZipNameCodePage = (typeof ZIP_NAME_CODE_PAGES)[number];

/** The ZIP specification's code page for names that declare none. */
export const SPECIFICATION_ZIP_NAME_CODE_PAGE =
  "ibm437" satisfies ZipNameCodePage;

/** Practice jurisdictions whose Windows writes ZIP names in code page 852. */
const CODE_PAGE_852_JURISDICTIONS: ReadonlySet<string> = new Set([
  "CZ",
  "SK",
  "PL",
  "HU",
]);

/** The code page for an organization practising in these countries. */
export const zipNameCodePageFor = (
  countryCodes: Iterable<string>,
): ZipNameCodePage => {
  for (const countryCode of countryCodes) {
    if (CODE_PAGE_852_JURISDICTIONS.has(countryCode.toUpperCase())) {
      return "ibm852";
    }
  }
  return SPECIFICATION_ZIP_NAME_CODE_PAGE;
};

/** The environment variable that carries the code page into the worker. */
export const ZIP_NAME_CODE_PAGE_ENV = "STELLA_ZIP_NAME_CODE_PAGE";

const isZipNameCodePage = (value: string): value is ZipNameCodePage =>
  ZIP_NAME_CODE_PAGES.some((codePage) => codePage === value);

/**
 * The code page a worker run was given. A run given none reads no archive
 * names the API asked it to (an image smoke, a mode that opens no ZIP) and
 * keeps the specification's; a value the API never writes is a defect.
 */
export const zipNameCodePageFromEnv = (
  value: string | undefined,
): ZipNameCodePage => {
  if (value === undefined) {
    return SPECIFICATION_ZIP_NAME_CODE_PAGE;
  }
  return isZipNameCodePage(value)
    ? value
    : panic("The extraction worker was given an unknown ZIP name code page");
};

/** In the extraction worker: the code page its run was given. */
export const readWorkerZipNameCodePage = (): ZipNameCodePage =>
  zipNameCodePageFromEnv(process.env[ZIP_NAME_CODE_PAGE_ENV]);
