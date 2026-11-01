import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { parseBunLockText } from "./bun-lock-text";

type LockedPackage = {
  integrity: string;
  version: string;
};

class AutofixOxlintError extends Error {
  readonly _tag = "AutofixOxlintError";

  constructor(message: string) {
    super(message);
    this.name = "AutofixOxlintError";
  }
}

const lockedPackage = (lockText: string, name: string): LockedPackage => {
  const lock = parseBunLockText(lockText);
  if (typeof lock !== "object" || lock === null || !("packages" in lock)) {
    throw new AutofixOxlintError("bun.lock has no packages table");
  }
  const packages = lock.packages;
  if (typeof packages !== "object" || packages === null) {
    throw new AutofixOxlintError("bun.lock has no packages table");
  }
  const entry = Reflect.get(packages, name);
  if (!Array.isArray(entry)) {
    throw new AutofixOxlintError(
      `bun.lock has no root package entry for ${name}`,
    );
  }
  const resolution: unknown = entry.at(0);
  const integrity: unknown = entry.at(3);
  const prefix = `${name}@`;
  if (
    typeof resolution !== "string" ||
    !resolution.startsWith(prefix) ||
    typeof integrity !== "string" ||
    !integrity.startsWith("sha512-")
  ) {
    throw new AutofixOxlintError(
      `bun.lock has an invalid root package entry for ${name}`,
    );
  }
  return { version: resolution.slice(prefix.length), integrity };
};

export const readAutofixOxlint = (lockText: string) => {
  const oxlint = lockedPackage(lockText, "oxlint");
  const binding = lockedPackage(lockText, "@oxlint/binding-linux-x64-gnu");
  if (binding.version !== oxlint.version) {
    throw new AutofixOxlintError(
      "oxlint and its Linux binding versions differ in bun.lock",
    );
  }
  return { oxlint, binding };
};

export const integrityMatches = (contents: Uint8Array, integrity: string) =>
  `sha512-${createHash("sha512").update(contents).digest("base64")}` ===
  integrity;

const tarballUrl = (name: string, version: string) => {
  const basename = name.slice(name.lastIndexOf("/") + 1);
  return `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`;
};

if (import.meta.main) {
  const command = process.argv[2];
  const lockPath = process.argv[3] ?? "bun.lock";
  const locked = readAutofixOxlint(readFileSync(lockPath, "utf-8"));
  if (command === "metadata") {
    console.log(`version=${locked.oxlint.version}`);
    console.log(`oxlint-url=${tarballUrl("oxlint", locked.oxlint.version)}`);
    console.log(`oxlint-integrity=${locked.oxlint.integrity}`);
    console.log(
      `binding-url=${tarballUrl("@oxlint/binding-linux-x64-gnu", locked.binding.version)}`,
    );
    console.log(`binding-integrity=${locked.binding.integrity}`);
  } else if (command === "verify") {
    const archive = process.argv[4];
    const packageName = process.argv[5];
    if (!archive || (packageName !== "oxlint" && packageName !== "binding")) {
      throw new AutofixOxlintError(
        "usage: autofix-oxlint.ts verify LOCK ARCHIVE oxlint|binding",
      );
    }
    const expected = locked[packageName].integrity;
    if (!integrityMatches(readFileSync(archive), expected)) {
      throw new AutofixOxlintError(
        `${packageName} tarball does not match bun.lock integrity`,
      );
    }
  } else {
    throw new AutofixOxlintError("usage: autofix-oxlint.ts metadata [LOCK]");
  }
}
