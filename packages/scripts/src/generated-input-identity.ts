import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

import type { Sha256Hasher } from "../../sha256/src/types";
import { ciGeneratedFiles } from "./generated-file-inventory";

type GeneratedInputGitOptions = {
  root: string;
  args: string[];
  onFailure: (message: string) => never;
};
export const generatedInputGit = ({
  root,
  args,
  onFailure,
}: GeneratedInputGitOptions) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    return onFailure(
      `Generated source input inventory failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
};

type GeneratedInputTreeHashOptions = {
  root: string;
  toolchain: unknown;
  generatedOutputs: "exclude" | "tracked";
  excluded?: ReadonlySet<string>;
  createHasher: () => Sha256Hasher;
  hashFile: (contents: string | Uint8Array) => string;
  onFailure: (message: string) => never;
};
export const generatedInputTreeHash = ({
  root,
  toolchain,
  generatedOutputs,
  excluded = new Set<string>(ciGeneratedFiles(root)),
  createHasher,
  hashFile,
  onFailure,
}: GeneratedInputTreeHashOptions) => {
  const hash = createHasher();
  hash.update(JSON.stringify(toolchain));
  // A full tracked closure covers newly added generator inputs automatically.
  // Generated outputs are derived from these inputs and the resolved toolchain.
  for (const entry of generatedInputGit({
    root,
    args: ["ls-files", "--stage", "-z"],
    onFailure,
  }).split("\0")) {
    if (entry === "") {
      continue;
    }
    const separator = entry.indexOf("\t");
    if (separator === -1) {
      return onFailure("Generated source input inventory has no path");
    }
    const file = entry.slice(separator + 1);
    if (excluded.has(file)) {
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
    hash.update(JSON.stringify([entry.slice(0, 6), file, hashFile(bytes)]));
  }
  return hash.digest("hex");
};
