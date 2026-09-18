import { Result } from "better-result";

import { loadDocxArchive } from "@/api/lib/docx-archive";
import {
  convertToHouseStyle,
  danglingStyleReferences,
  readStyleCatalogue,
} from "@/api/lib/house-style/convert";
import {
  bindStyleGuide,
  parseStyleGuideDraft,
} from "@/api/lib/house-style/guide";
import {
  parseConvertArgs,
  renderConversionReport,
  USAGE,
} from "@/api/scripts/house-style-convert.logic";
import type { ConvertCommand } from "@/api/scripts/house-style-convert.logic";

/**
 * Convert a document into a house style from the command line.
 *
 * The same library the API calls: a style set's DOCX is the container, its
 * catalogue is extracted from it, a written style guide says what each style
 * is for, and the decision model chooses one per paragraph. What the command
 * line adds is the two files and the report.
 *
 *   cd apps/api && bun --env-file=.env src/scripts/house-style-convert.ts \
 *     --house house.docx --write-catalogue catalogue.json --rename OLD=new
 *
 *   cd apps/api && bun --env-file=.env src/scripts/house-style-convert.ts \
 *     --house house.docx --input draft.docx --guide guide.json \
 *     --out converted.docx --report report.json --rename OLD=new
 */

const USAGE_EXIT_CODE = 2;

const fail: (message: string) => never = (message) => {
  console.error(message);
  console.error(USAGE);
  process.exit(USAGE_EXIT_CODE);
};

const abort: (message: string) => never = (message) => {
  console.error(message);
  process.exit(USAGE_EXIT_CODE);
};

const parsed = parseConvertArgs(process.argv.slice(2));
if (Result.isError(parsed)) {
  fail(parsed.error.message);
}
if (parsed.value.type === "help") {
  console.log(USAGE);
  process.exit(0);
}
const command = parsed.value;

const readBytes = async (path: string): Promise<ArrayBuffer> => {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    abort(`no such file: ${path}`);
  }
  return await file.arrayBuffer();
};

const houseBytes = await readBytes(command.house);

if (command.type === "catalogue") {
  const catalogue = await readStyleCatalogue({
    bytes: houseBytes,
    rename: command.rename,
  });
  if (Result.isError(catalogue)) {
    abort(catalogue.error.message);
  }
  await Bun.write(
    command.cataloguePath,
    `${JSON.stringify(catalogue.value, null, 2)}\n`,
  );
  console.log(
    `${String(catalogue.value.styles.length)} paragraph styles in use; wrote ${command.cataloguePath}`,
  );
  process.exit(0);
}

const convert = async (options: ConvertCommand): Promise<void> => {
  const catalogue = await readStyleCatalogue({
    bytes: houseBytes,
    rename: options.rename,
  });
  if (Result.isError(catalogue)) {
    abort(catalogue.error.message);
  }
  const guideJson: unknown = await Bun.file(options.guide).json();
  const draft = parseStyleGuideDraft(guideJson);
  if (Result.isError(draft)) {
    abort(draft.error.message);
  }
  const guide = bindStyleGuide({
    draft: draft.value,
    catalogue: catalogue.value,
  });
  if (Result.isError(guide)) {
    const { error } = guide;
    abort(
      error._tag === "StyleGuideError"
        ? `${error.message}: ${error.unknownStyleIds.join(", ")}`
        : `${error.message}: the guide names ${error.writtenFor}, this style set is ${error.catalogueHash}`,
    );
  }

  const converted = await convertToHouseStyle({
    styleSetBytes: houseBytes,
    sourceBytes: await readBytes(options.input),
    guide: guide.value,
    orgAIConfig: null,
    rename: options.rename,
    limit: options.limit,
  });
  if (Result.isError(converted)) {
    abort(converted.error.message);
  }

  const { bytes, rows, summary } = converted.value;
  console.log(renderConversionReport({ rows, summary }));

  if (options.report !== null) {
    await Bun.write(
      options.report,
      `${JSON.stringify({ options, summary, rows }, null, 2)}\n`,
    );
    console.log(`\nwrote ${options.report}`);
  }
  if (options.out === null) {
    console.log("\n--dry-run: no document written");
    return;
  }
  await Bun.write(options.out, bytes);

  // The output is only useful if Word can open it, and the one way this
  // rewrite can produce an unopenable file is a paragraph naming a style the
  // package does not define. Read back from disk, not from the bytes in
  // hand, so the zip that was written is the one that is checked.
  const archive = await loadDocxArchive(await readBytes(options.out));
  const documentXml = await archive.readEntryString("word/document.xml");
  const stylesXml = await archive.readEntryString("word/styles.xml");
  if (documentXml === null || stylesXml === null) {
    abort("the converted document lost its document or style part");
  }
  const dangling = danglingStyleReferences({ documentXml, stylesXml });
  if (dangling.length > 0) {
    abort(
      `the converted document names styles it does not define: ${dangling.join(", ")}`,
    );
  }
  console.log(`\nwrote ${options.out}`);
};

await convert(command);
process.exit(0);
