import { panic } from "better-result";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadLocalModule } from "@stll/start-runtime/local-module-loader";

import {
  engineParityCases,
  engineParityOutputDirectory,
  engineParityXmlDigests,
} from "@/api/tests/helpers/docx-engine-parity";

// bun --cwd apps/api scripts/record-docx-engine-parity.ts [git-ref]
// Record the main DOCX engine's XML parts, excluding ZIP metadata.
import type * as DocxEngine from "../src/lib/docx/patch-template";

const isRecordedEngine = (
  value: unknown,
): value is Pick<typeof DocxEngine, "fillTemplate"> =>
  typeof value === "object" &&
  value !== null &&
  "fillTemplate" in value &&
  typeof value.fillTemplate === "function";

const ref = process.argv[2] ?? "origin/main";
const enginePath = "apps/api/src/lib/docx";
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const revision = execFileSync("git", ["rev-parse", ref], {
  cwd: repository,
  encoding: "utf-8",
}).trim();
const temporary = await mkdtemp(
  fileURLToPath(new URL("../src/lib/docx/.main-engine-", import.meta.url)),
);
try {
  const archive = `${temporary}/engine.tar`;
  execFileSync("git", ["archive", "--output", archive, revision, enginePath], {
    cwd: repository,
  });
  execFileSync("tar", [
    "-xf",
    archive,
    "--strip-components=5",
    "-C",
    temporary,
  ]);
  const loaded = await loadLocalModule({
    root: temporary,
    modulePath: "patch-template.ts",
  });
  if (loaded.isErr()) {
    throw loaded.error;
  }
  const engine = loaded.value;
  if (!isRecordedEngine(engine)) {
    panic("Recorded engine must export fillTemplate");
  }
  await mkdir(engineParityOutputDirectory, { recursive: true });
  for (const { name, file, values } of await engineParityCases()) {
    const result = await engine.fillTemplate(file, values);
    if (result.structureErrors.length > 0) {
      panic(
        `Invalid parity fixture ${name}: ${JSON.stringify(result.structureErrors)}`,
      );
    }
    await Bun.write(
      new URL(`${name}.json`, engineParityOutputDirectory),
      await engineParityXmlDigests(result.file),
    );
  }
  await Bun.write(
    new URL("source.txt", engineParityOutputDirectory),
    `${revision}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
