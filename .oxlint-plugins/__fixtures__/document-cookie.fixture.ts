// Passive regression fixture for the native `unicorn/no-document-cookie`
// rule, which enforces AGENTS.md's "No direct `document.cookie` assignment".
//
// Each `oxlint-disable-next-line` below suppresses a write the rule MUST
// flag. If the rule is switched off or regresses, the disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails the fixture.

declare const document: { cookie: string; title: string };
declare const window: { document: { cookie: string } };
declare const self: { document: { cookie: string } };
declare const value: string;

export const directAssign = () => {
  // oxlint-disable-next-line unicorn/no-document-cookie
  document.cookie = "theme=dark";
};

export const compoundAssign = () => {
  // oxlint-disable-next-line unicorn/no-document-cookie
  document.cookie += "; foo=bar";
};

// A member of the global object.
export const windowAssign = () => {
  // oxlint-disable-next-line unicorn/no-document-cookie
  window.document.cookie = value;
};

export const selfAssign = () => {
  // oxlint-disable-next-line unicorn/no-document-cookie
  self.document.cookie = value;
};

// Computed member.
export const bracketAssign = () => {
  // oxlint-disable-next-line unicorn/no-document-cookie, typescript/dot-notation
  document["cookie"] = "theme=dark";
};

// Reads are allowed.
export const readCookie = () => document.cookie;

// An unrelated object with a `cookie` property.
declare const otherDocument: { cookie: number };
export const unrelatedAssign = () => {
  otherDocument.cookie = 1;
};
