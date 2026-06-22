// Passive regression fixture for `no-raw-locale-format/no-raw-locale-format`.
//
// `oxlint-disable-next-line` directives below intentionally suppress cases
// the rule MUST flag. If the rule regresses, the disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI.
//
// Lines without a disable directive must continue to pass — they cover
// the allow-list (full formatting locale via getFormattingLocale(), or a
// resolved `locale` variable from use-intl's useLocale()).

declare const getFormattingLocale: () => string;
declare const someDate: Date;
declare const lang: string;
declare const locale: string;

// --- Flagged: bare / absent / base-language locale ---
// oxlint-disable-next-line no-raw-locale-format/no-raw-locale-format
const _nf = new Intl.NumberFormat();
// oxlint-disable-next-line no-raw-locale-format/no-raw-locale-format
const _dtf = new Intl.DateTimeFormat("en-US");
// oxlint-disable-next-line no-raw-locale-format/no-raw-locale-format
const _rtf = new Intl.RelativeTimeFormat(lang);
// oxlint-disable-next-line no-raw-locale-format/no-raw-locale-format
const _d1 = someDate.toLocaleDateString();
// oxlint-disable-next-line no-raw-locale-format/no-raw-locale-format
const _d2 = someDate.toLocaleString(undefined, { dateStyle: "full" });
// oxlint-disable-next-line no-raw-locale-format/no-raw-locale-format
const _n1 = (123).toLocaleString(lang);

// --- Allowed: full formatting locale (must NOT be flagged) ---
const _ok1 = new Intl.NumberFormat(getFormattingLocale());
const _ok2 = someDate.toLocaleDateString(locale);

export const __noRawLocaleFormatFixture = {
  _nf,
  _dtf,
  _rtf,
  _d1,
  _d2,
  _n1,
  _ok1,
  _ok2,
};
