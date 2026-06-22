// Disallow ad-hoc locale-sensitive formatting that ignores the user's
// formatting preferences.
//
// `new Intl.NumberFormat / DateTimeFormat / RelativeTimeFormat(...)` and
// the `.toLocaleString / .toLocaleDateString / .toLocaleTimeString`
// methods fall back to the runtime default locale (or a bare language
// tag like "ar"/"en") unless given the FULL formatting locale. That
// drops the user's numbering-system and calendar preferences — e.g.
// Eastern Arabic-Indic digits (٠١٢٣) for `ar` — so numbers and dates
// render inconsistently across surfaces.
//
// Route through the central formatter instead:
//   - React:     useFormatter() / useLocale() from use-intl
//   - non-React: getFormatter() from @/i18n/i18n-store
//   - or pass getFormattingLocale() explicitly as the locale argument.
//
// Flagged (locale argument is missing, `undefined`, a string literal,
// or the base-language `lang` variable):
//   new Intl.NumberFormat()
//   new Intl.DateTimeFormat("en-US")
//   date.toLocaleDateString(undefined, opts)
//   date.toLocaleString(lang, opts)
//
// Allowed (carries the full formatting locale):
//   new Intl.RelativeTimeFormat(getFormattingLocale(), opts)
//   date.toLocaleDateString(locale, opts)   // locale = useLocale()
//
// The central formatting modules build these from a resolved locale and
// are allowlisted in oxlint.config.ts.

const INTL_FORMATTERS = new Set([
  "NumberFormat",
  "DateTimeFormat",
  "RelativeTimeFormat",
]);

const TO_LOCALE_METHODS = new Set([
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
]);

// True when the locale argument provably ignores the user's preferences:
// absent, `undefined`, a hardcoded string, or the base-language `lang`.
const isBareLocaleArg = (arg) => {
  if (arg === undefined) {
    return true;
  }
  if (arg.type === "Identifier") {
    return arg.name === "undefined" || arg.name === "lang";
  }
  return arg.type === "Literal" && typeof arg.value === "string";
};

export default {
  meta: { name: "no-raw-locale-format" },
  rules: {
    "no-raw-locale-format": {
      meta: {
        type: "problem",
        messages: {
          rawLocaleFormat:
            "Locale-sensitive formatting bypasses the user's number/date " +
            "preferences. Use getFormatter()/useFormatter(), or pass " +
            "getFormattingLocale() (from @/i18n/i18n-store) as the locale.",
        },
      },
      create(context) {
        return {
          NewExpression(node) {
            const callee = node.callee;
            if (
              callee.type === "MemberExpression" &&
              callee.object.type === "Identifier" &&
              callee.object.name === "Intl" &&
              callee.property.type === "Identifier" &&
              INTL_FORMATTERS.has(callee.property.name) &&
              isBareLocaleArg(node.arguments[0])
            ) {
              context.report({ node, messageId: "rawLocaleFormat" });
            }
          },
          CallExpression(node) {
            const callee = node.callee;
            if (
              callee.type === "MemberExpression" &&
              callee.property.type === "Identifier" &&
              TO_LOCALE_METHODS.has(callee.property.name) &&
              isBareLocaleArg(node.arguments[0])
            ) {
              context.report({ node, messageId: "rawLocaleFormat" });
            }
          },
        };
      },
    },
  },
};
