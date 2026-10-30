import { readFileSync } from "node:fs";

const markers: string[] = JSON.parse(
  readFileSync(new URL("pr-body-log-markers.json", import.meta.url), "utf-8"),
);

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const markerPatterns = markers.map((marker) => ({
  marker,
  pattern: new RegExp(
    `^\\s*(?:(?:[-*+]|1\\.)\\s*)?\`*${escapeRegExp(marker)}`,
    "iu",
  ),
}));

export const checkPrBody = (body: string) => {
  const offenses: { line: number; marker: string }[] = [];
  for (const [index, line] of body.split(/\r?\n/u).entries()) {
    for (const { marker, pattern } of markerPatterns) {
      if (pattern.test(line)) {
        offenses.push({ line: index + 1, marker });
        break;
      }
    }
  }
  return offenses;
};

export const formatPrBodyCheck = (body: string) => {
  const offenses = checkPrBody(body);
  return {
    exitCode: offenses.length === 0 ? 0 : 1,
    lines: [
      ...offenses.map(({ line, marker }) => `line ${line}: ${marker}`),
      ...(offenses.length === 0
        ? []
        : [
            "PR body contains tool log lines; keep logs out of the description",
          ]),
    ],
  };
};

if (process.argv[1] === import.meta.filename) {
  const result = formatPrBodyCheck(process.env["PR_BODY"] ?? "");
  for (const line of result.lines) {
    console.log(line);
  }
  process.exitCode = result.exitCode;
}
