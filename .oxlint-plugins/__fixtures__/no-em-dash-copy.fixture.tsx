// Passive regression fixture for `no-em-dash-copy/no-em-dash-copy`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

// --- Flagged: the glyph written into copy ---
// oxlint-disable-next-line no-em-dash-copy/no-em-dash-copy
export const label = "Saved — just now";
// oxlint-disable-next-line no-em-dash-copy/no-em-dash-copy
export const summary = (count: number) => `${count} items — sorted`;
export const _a = () => (
  <p>
    {/* oxlint-disable-next-line no-em-dash-copy/no-em-dash-copy */}
    Draft — not sent
  </p>
);
export const _b = () => (
  <p>
    {/* oxlint-disable-next-line no-em-dash-copy/no-em-dash-copy */}
    Draft &mdash; not sent
  </p>
);
// oxlint-disable-next-line no-em-dash-copy/no-em-dash-copy
export const _c = () => <span title="Draft &mdash; not sent" />;

// --- Allowed: the character as data, en dash ranges, comments ---
// expect-clean: no-em-dash-copy/no-em-dash-copy
export const DASHES = ["\u2014", "\u2013"];
export const normalize = (text: string) => text.replaceAll(/—/gu, "-");
export const range = "2019–2024";
export const missing = (value: string | null) => value ?? "—";
export const _e = () => <span>—</span>;
// A comment may say "draft — not sent".
export const _d = () => <p>Draft: not sent</p>;

// oxlint-disable-next-line no-em-dash-copy/no-em-dash-copy
export const _f = (a: string) => <p>{a}—</p>;
// oxlint-disable-next-line no-em-dash-copy/no-em-dash-copy
export const _g = (b: string) => <p>—{b}</p>;
// oxlint-disable-next-line no-em-dash-copy/no-em-dash-copy
export const _h = (a: string, b: string) => <p>{a} — {b}</p>;
// oxlint-disable-next-line no-em-dash-copy/no-em-dash-copy
export const _i = (a: string) => <p>{a}{"—"}</p>;
export const _j = () => <td>{"—"}</td>;
