import { collapseLetterSpacing } from "@stll/text-normalize";

declare const text: string;

// oxlint-disable-next-line no-local-letter-spacing/no-local-letter-spacing -- fixture proves a hand-written letter join is reported
const _joined = text.replace(/(?<=\p{L}) (?=\p{L})/gu, "");
// oxlint-disable-next-line no-local-letter-spacing/no-local-letter-spacing -- fixture proves a hand-written spaced run is reported
const _run = /^(?:\p{L} +)+\p{L}$/u.test(text);
// oxlint-disable-next-line no-local-letter-spacing/no-local-letter-spacing, prefer-regex-literals -- fixture proves a constructed pattern is reported
const _constructed = new RegExp("(?:\\p{L} ){3,}\\p{L}", "u");

// expect-clean: no-local-letter-spacing/no-local-letter-spacing
const _owned = collapseLetterSpacing(text);
const _digits = text.replace(/(?<=\p{L}) (?=\d)/gu, "");
const _words = /\p{L}[\p{L}\p{M}]*/gu.test(text);
