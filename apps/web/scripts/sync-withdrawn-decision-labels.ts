import { panic } from "better-result";
import { readdir, readFile, writeFile } from "node:fs/promises";

const namespacesDir = new URL("../src/i18n/namespaces/", import.meta.url);
const output = new URL(
  "../../api/src/lib/case-law/withdrawn-decision-labels.gen.json",
  import.meta.url,
);
const labels = new Map<string, string>();
// caseLaw.withdrawnByPublisher is also served by non-web read projections.
const localeDirs = (await readdir(namespacesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted();

for (const locale of localeDirs) {
  const catalog: unknown = JSON.parse(
    await readFile(new URL(`${locale}/legal.json`, namespacesDir), "utf-8"),
  );
  if (
    typeof catalog !== "object" ||
    catalog === null ||
    !("caseLaw" in catalog)
  ) {
    panic(`Missing caseLaw catalog in ${locale}/legal.json`);
  }
  const group = catalog.caseLaw;
  if (
    typeof group !== "object" ||
    group === null ||
    !("withdrawnByPublisher" in group) ||
    typeof group.withdrawnByPublisher !== "string"
  ) {
    panic(`Missing caseLaw.withdrawnByPublisher in ${locale}/legal.json`);
  }
  labels.set(locale, group.withdrawnByPublisher);
}
const source = `${JSON.stringify(Object.fromEntries(labels), null, 2)}\n`;
if (process.argv.includes("--check")) {
  if ((await readFile(output, "utf-8")) !== source) {
    panic("Withdrawn decision labels differ from the catalogs");
  }
} else {
  await writeFile(output, source);
}
