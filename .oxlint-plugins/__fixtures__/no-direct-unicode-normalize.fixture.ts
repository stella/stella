import path from "node:path";

import { normalizeUnicode } from "@stll/text-normalize";

declare const normalization: "NFC" | "NFD" | "NFKC" | "NFKD";
declare const text: string;
declare const form: string;

// oxlint-disable-next-line no-direct-unicode-normalize/no-direct-unicode-normalize -- fixture proves the default NFC form is reported
const _default = text.normalize();
// oxlint-disable-next-line no-direct-unicode-normalize/no-direct-unicode-normalize -- fixture proves literal forms are reported
const _literal = text.normalize("NFC");
// oxlint-disable-next-line no-direct-unicode-normalize/no-direct-unicode-normalize, typescript/dot-notation -- fixture proves computed member syntax is reported
const _computed = text["normalize"]("NFD");
// oxlint-disable-next-line no-direct-unicode-normalize/no-direct-unicode-normalize -- fixture proves conventional form variables are reported
const _variable = text.normalize(normalization);
// oxlint-disable-next-line no-direct-unicode-normalize/no-direct-unicode-normalize -- fixture proves arbitrary form expressions are reported
const _expression = text.normalize(form || "NFC");
// oxlint-disable-next-line no-direct-unicode-normalize/no-direct-unicode-normalize -- fixture proves hand-rolled mark stripping is reported
const _marks = text.replaceAll(/\p{M}/gu, "");
// oxlint-disable-next-line no-direct-unicode-normalize/no-direct-unicode-normalize -- fixture proves Mn stripping without a Unicode flag is reported
const _nonspacingMarks = text.replace(/\p{Mn}/g, "");
// oxlint-disable-next-line no-direct-unicode-normalize/no-direct-unicode-normalize -- fixture proves the basic combining range without a Unicode flag is reported
const _basicMarks = text.replaceAll(/[̀-ͯ]/g, "");

// expect-clean: no-direct-unicode-normalize/no-direct-unicode-normalize
const _owned = normalizeUnicode(text, "NFKC");
const _path = path.normalize(text);
const _unrelated = { normalize: (value: number) => value }.normalize(1);
