import { readFileSync } from "node:fs";

const BUNFIG_PATH = "bunfig.toml";
const EXPIRY_MARKER = "quarantine-expires:";
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const bunfig = readFileSync(BUNFIG_PATH, "utf8");
const errors = [];
let temporaryExcludes = 0;

for (const [index, line] of bunfig.split("\n").entries()) {
  if (!line.includes(EXPIRY_MARKER)) continue;

  const match =
    /^\s*"(?<name>[^"]+)"\s*,\s*#\s*quarantine-expires:\s*(?<expires>\S+)\s*$/u.exec(
      line,
    );
  if (match === null) {
    errors.push(
      `${BUNFIG_PATH}:${index + 1} has a malformed quarantine expiry`,
    );
    continue;
  }

  const name = match.groups?.name;
  const expiresAt = match.groups?.expires;
  if (name === undefined || expiresAt === undefined) {
    errors.push(
      `${BUNFIG_PATH}:${index + 1} has a malformed quarantine expiry`,
    );
    continue;
  }

  const expiresAtMs = Date.parse(expiresAt);
  if (
    !UTC_TIMESTAMP.test(expiresAt) ||
    Number.isNaN(expiresAtMs) ||
    new Date(expiresAtMs).toISOString() !== expiresAt
  ) {
    errors.push(
      `${BUNFIG_PATH}:${index + 1} temporary exclude "${name}" has an invalid UTC expiry: ${expiresAt}`,
    );
    continue;
  }

  temporaryExcludes += 1;
  if (Date.now() >= expiresAtMs) {
    errors.push(
      `${BUNFIG_PATH}:${index + 1} temporary exclude "${name}" expired at ${expiresAt}; remove the exemption`,
    );
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(
  `${BUNFIG_PATH}: ${temporaryExcludes} temporary quarantine exclude(s) have valid future expiry dates`,
);
