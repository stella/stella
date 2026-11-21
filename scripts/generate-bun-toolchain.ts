import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import { writeOrCheckArtifacts } from "./generated-artifacts";

const manifestSchema = v.object({
  packageManager: v.pipe(v.string(), v.startsWith("bun@"), v.minLength(5)),
});

export const generateBunToolchain = async (
  root: string,
  write: boolean,
): Promise<number> => {
  const manifest: unknown = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf-8"),
  );
  const { packageManager } = v.parse(manifestSchema, manifest);
  const directory = path.join(root, "scripts");
  if (write) {
    await mkdir(directory, { recursive: true });
  }
  return await writeOrCheckArtifacts(
    [
      {
        path: path.join(directory, "bun-toolchain.gen.json"),
        contents: `${JSON.stringify({ packageManager }, null, 2)}\n`,
      },
    ],
    { matched: "the root Bun toolchain pin", write },
  );
};

if (import.meta.main) {
  process.exitCode = await generateBunToolchain(
    path.resolve(import.meta.dirname, ".."),
    process.argv.includes("--write"),
  );
}
