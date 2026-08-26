import { panic } from "better-result";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerations } from "@/api/db/schema/corpus-index-generations";
import {
  corpusIndexManifestDigest,
  requireCorpusIndexManifest,
  type CorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";

type GenerationTargetFor<TManifest extends CorpusIndexManifest> =
  TManifest extends CorpusIndexManifest
    ? Pick<TManifest, "family" | "generation">
    : never;

export type CorpusIndexGenerationTarget =
  GenerationTargetFor<CorpusIndexManifest>;

export const requireRegisteredCorpusIndexManifest = ({
  family,
  generation,
  cluster,
  manifestDigest,
}: typeof corpusIndexGenerations.$inferSelect): CorpusIndexManifest => {
  const manifest = requireCorpusIndexManifest(family, generation);
  const expectedDigest = corpusIndexManifestDigest(manifest);
  if (cluster !== manifest.cluster || manifestDigest !== expectedDigest) {
    return panic(
      `Corpus generation contract mismatch: ${family}/${generation}`,
    );
  }
  return manifest;
};

/**
 * Register one immutable final-generation contract before any writer targets
 * it. Replays converge; an existing retired or mismatched binding fails closed.
 */
export const registerCorpusIndexGenerationTx = async (
  tx: Transaction,
  target: CorpusIndexGenerationTarget,
): Promise<CorpusIndexManifest> => {
  const manifest = requireCorpusIndexManifest(target.family, target.generation);
  await tx
    .insert(corpusIndexGenerations)
    .values({
      family: manifest.family,
      generation: manifest.generation,
      cluster: manifest.cluster,
      manifestDigest: corpusIndexManifestDigest(manifest),
      status: "building",
    })
    .onConflictDoNothing();
  const rows = await tx
    .select()
    .from(corpusIndexGenerations)
    .where(
      and(
        eq(corpusIndexGenerations.family, manifest.family),
        eq(corpusIndexGenerations.generation, manifest.generation),
      ),
    )
    .limit(1)
    .for("share");
  const row = rows.at(0);
  if (
    row === undefined ||
    (row.status !== "building" && row.status !== "serving")
  ) {
    return panic(
      `Active corpus generation registration failed: ${target.family}/${target.generation}`,
    );
  }
  return requireRegisteredCorpusIndexManifest(row);
};
