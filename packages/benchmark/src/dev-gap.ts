import { createHash } from "node:crypto";

import { loadVerifiedTabDevCorpus, type TabDocument } from "./blind/tab";
import { createPythonAdapter } from "./adapters/python";
import { PRESIDIO_PROVIDER } from "./adapters/python-providers";
import { createStllAdapter } from "./adapters/stella";
import type { NativePrediction } from "./adapters/types";
import type { GroundTruthDocument } from "./ground-truth";

const SAMPLE_SIZE = 5;
const SAMPLE_SEED = "stella-tab-development-gap-v1";
const exampleArgument = process.argv
  .slice(2)
  .find(
    (argument) =>
      argument === "--examples" || argument.startsWith("--examples="),
  );
const includeExamples = exampleArgument !== undefined;
const exampleEntityType = exampleArgument?.startsWith("--examples=")
  ? exampleArgument.slice("--examples=".length).trim().toUpperCase()
  : undefined;
if (exampleEntityType === "") {
  throw new Error("--examples=<entity-type> requires a non-empty entity type");
}
if (includeExamples) {
  process.stderr.write(
    "WARNING: --examples prints entity text from public legal documents; keep this local and do not paste it into CI logs.\n",
  );
}
const selected = (documents: readonly TabDocument[]): TabDocument[] =>
  [...documents]
    .sort((left, right) =>
      createHash("sha256")
        .update(`${SAMPLE_SEED}\0${left.id}`)
        .digest("hex")
        .localeCompare(
          createHash("sha256")
            .update(`${SAMPLE_SEED}\0${right.id}`)
            .digest("hex"),
        ),
    )
    .slice(0, SAMPLE_SIZE);

const corpus = selected(await loadVerifiedTabDevCorpus());
const inputs: GroundTruthDocument[] = corpus.map(({ id, text }) => ({
  id,
  text,
  title: id,
  language: "en",
  entities: [],
}));
const adapters = [createStllAdapter(), createPythonAdapter(PRESIDIO_PROVIDER)];
const predictions = new Map<
  string,
  ReadonlyMap<string, readonly NativePrediction[]>
>();
for (const adapter of adapters) {
  process.stderr.write(`running development adapter ${adapter.name}...\n`);
  const outcome = await adapter.run(inputs);
  if (outcome.status === "unavailable") {
    throw new Error(`${adapter.name} unavailable: ${outcome.reason}`);
  }
  predictions.set(adapter.name, outcome.predictions);
}

const covers = (
  spans: readonly NativePrediction[],
  start: number,
  end: number,
): boolean => spans.some((span) => span.start <= start && span.end >= end);
const rows = new Map<
  string,
  { total: number; stella: number; presidio: number }
>();
const examples: string[] = [];
for (const document of corpus) {
  const stella = predictions.get("stella")?.get(document.id) ?? [];
  const presidio = predictions.get("presidio")?.get(document.id) ?? [];
  for (const annotation of document.annotations) {
    for (const mention of annotation.mentions) {
      if (mention.identifierType === "NO_MASK") continue;
      const row = rows.get(mention.entityType) ?? {
        total: 0,
        stella: 0,
        presidio: 0,
      };
      row.total += 1;
      const stellaCovered = covers(stella, mention.start, mention.end);
      const presidioCovered = covers(presidio, mention.start, mention.end);
      if (stellaCovered) row.stella += 1;
      if (presidioCovered) row.presidio += 1;
      rows.set(mention.entityType, row);
      if (
        includeExamples &&
        (exampleEntityType === undefined ||
          mention.entityType === exampleEntityType) &&
        !stellaCovered &&
        presidioCovered &&
        examples.length < 20
      ) {
        examples.push(
          `${document.id}\t${mention.entityType}\t${JSON.stringify(document.text.slice(mention.start, mention.end))}`,
        );
      }
    }
  }
}

console.log(`TAB development sample: ${corpus.map(({ id }) => id).join(", ")}`);
console.log("entity_type\ttotal\tstella\tpresidio");
for (const [entityType, row] of [...rows].sort(
  ([, left], [, right]) => right.total - left.total,
)) {
  console.log(`${entityType}\t${row.total}\t${row.stella}\t${row.presidio}`);
}
if (includeExamples) {
  const scope = exampleEntityType === undefined ? "" : ` ${exampleEntityType}`;
  console.log(
    `\nPresidio-covered, stella-missed${scope} development examples:`,
  );
  console.log(examples.join("\n"));
}
