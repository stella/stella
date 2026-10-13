import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

// This identity is also needed before dependency installation in CI.
import { createSha256, sha256Hex } from "../../sha256/src/bun";
import { CI_GENERATED_FILES } from "./generated-files";

class GeneratedInputError extends Error {
  override name = "GeneratedInputError";
  readonly _tag = "GeneratedInputError";
}

export const generatedInputGit = (root: string, args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    throw new GeneratedInputError(
      `Generated source input inventory failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
};

type GeneratedInputTreeHashOptions = {
  root: string;
  toolchain: unknown;
  generatedOutputs: "exclude" | "tracked";
};
export const generatedInputTreeHash = ({
  root,
  toolchain,
  generatedOutputs,
}: GeneratedInputTreeHashOptions) => {
  const generated = new Set<string>(CI_GENERATED_FILES);
  const hash = createSha256();
  hash.update(JSON.stringify(toolchain));
  // A full tracked closure covers newly added generator inputs automatically.
  // Generated outputs are derived from these inputs and the resolved toolchain.
  for (const entry of generatedInputGit(root, [
    "ls-files",
    "--stage",
    "-z",
  ]).split("\0")) {
    if (entry === "") {
      continue;
    }
    const separator = entry.indexOf("\t");
    if (separator === -1) {
      throw new GeneratedInputError(
        "Generated source input inventory has no path",
      );
    }
    const file = entry.slice(separator + 1);
    if (generated.has(file)) {
      if (generatedOutputs === "tracked") {
        // Hydration replaces working bytes. The index still identifies the
        // committed output that source consistency checks must validate.
        hash.update(
          JSON.stringify(["generated", file, entry.slice(0, separator)]),
        );
      }
      continue;
    }
    const absolute = path.join(root, file);
    const bytes = (() => {
      if (entry.startsWith("160000 ")) {
        return entry.slice(0, separator);
      }
      return lstatSync(absolute).isSymbolicLink()
        ? readlinkSync(absolute)
        : readFileSync(absolute);
    })();
    hash.update(JSON.stringify([entry.slice(0, 6), file, sha256Hex(bytes)]));
  }
  return hash.digest("hex");
};
