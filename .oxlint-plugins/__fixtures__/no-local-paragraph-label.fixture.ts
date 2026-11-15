import { readPrintedLabel } from "@stll/legal-ast/printed-paragraph-labels";

declare const line: string;

// oxlint-disable-next-line no-local-paragraph-label/no-local-paragraph-label -- fixture proves a hand-written numbered label is reported
const _numbered = /^\d{1,3}\.\s/u.test(line);
// oxlint-disable-next-line no-local-paragraph-label/no-local-paragraph-label -- fixture proves a hand-written bracketed label is reported
const _bracketed = /^\[(?<number>\d{1,4})\]/u.exec(line);
// oxlint-disable-next-line no-local-paragraph-label/no-local-paragraph-label, prefer-regex-literals -- fixture proves a constructed pattern is reported
const _constructed = new RegExp("^\\(?\\d{1,3}[.)]\\s", "u");

// expect-clean: no-local-paragraph-label/no-local-paragraph-label
const _owned = readPrintedLabel(line);
const _year = /^\d{4}-\d{2}/u.test(line);
const _inside = /\d{1,3}\./u.test(line);
