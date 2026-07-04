// Passive regression fixture for `no-document-cookie/no-document-cookie`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The
// allowed cases carry no disable, so a false positive would fail the
// fixture too.

declare const document: { cookie: string; title: string };
declare const window: { document: { cookie: string } };
declare const self: { document: { cookie: string } };
declare const value: string;

// MUST flag: direct assignment.
export const directAssign = () => {
  // oxlint-disable-next-line no-document-cookie/no-document-cookie
  document.cookie = "theme=dark";
};

// MUST flag: compound assignment.
export const compoundAssign = () => {
  // oxlint-disable-next-line no-document-cookie/no-document-cookie
  document.cookie += "; foo=bar";
};

// MUST flag: via window.document.cookie (also matches globalThis.document
// .cookie / self.document.cookie, not separately exercised here since
// `globalThis` is already an ambient global and cannot be re-declared).
export const windowAssign = () => {
  // oxlint-disable-next-line no-document-cookie/no-document-cookie
  window.document.cookie = value;
};

// MUST flag: via self.document.cookie.
export const selfAssign = () => {
  // oxlint-disable-next-line no-document-cookie/no-document-cookie
  self.document.cookie = value;
};

// MUST flag: bracket-notation bypass of dot-notation matching. Also
// suppresses `typescript/dot-notation`, an unrelated style rule that would
// otherwise flag the literal-key bracket access used here to exercise the
// bypass.
export const bracketAssign = () => {
  // oxlint-disable-next-line no-document-cookie/no-document-cookie, typescript/dot-notation
  document["cookie"] = "theme=dark";
};

// MUST flag: bracket-notation bypass via window.document, compound assign.
export const windowBracketAssign = () => {
  // oxlint-disable-next-line no-document-cookie/no-document-cookie, typescript/dot-notation
  window.document["cookie"] += value;
};

// Allowed — reading the cookie jar is fine.
export const readCookie = () => document.cookie;
export const readCookieIncludes = () => document.cookie.includes("theme=");

// Allowed — unrelated property assignment on an object named `document`.
declare const otherDocument: { cookie: number };
export const unrelatedAssign = () => {
  otherDocument.cookie = 1;
};

// Allowed — bracket-notation write to a non-"cookie" property. Suppresses
// the unrelated `typescript/dot-notation` style rule, not the rule under
// test: no `no-document-cookie` disable is present, so a false positive
// here would still fail the fixture.
export const unrelatedBracketAssign = () => {
  // oxlint-disable-next-line typescript/dot-notation
  document["title"] = "x";
};
