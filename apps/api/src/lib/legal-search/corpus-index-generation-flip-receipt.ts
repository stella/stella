/**
 * The digest of a generation flip receipt, as PostgreSQL computes it from the
 * stored row: SHA-256, in hex, of the row's canonical record, which is
 * `jsonb_build_object` over the pair, the actor, the reason, the flip instant
 * (epoch microseconds) and the evidence, rendered as `jsonb` text. `jsonb`
 * text is canonical (keys ordered, one spacing), so anyone holding the row can
 * reproduce the digest with this one expression; the table's check constraint
 * holds every stored row to it, and the flip's INSERT computes it with it.
 */
import { type SQL, sql } from "drizzle-orm";

/** The receipt columns the digest covers, as SQL expressions. */
export type CorpusIndexGenerationFlipReceiptColumns = {
  family: SQL;
  fromGeneration: SQL;
  toGeneration: SQL;
  actor: SQL;
  reason: SQL;
  flippedAt: SQL;
  evidence: SQL;
};

export const corpusIndexGenerationFlipReceiptDigest = ({
  family,
  fromGeneration,
  toGeneration,
  actor,
  reason,
  flippedAt,
  evidence,
}: CorpusIndexGenerationFlipReceiptColumns): SQL =>
  sql`encode(sha256(convert_to(jsonb_build_object('family', ${family}, 'from', ${fromGeneration}, 'to', ${toGeneration}, 'actor', ${actor}, 'reason', ${reason}, 'flippedAtUs', (extract(epoch FROM ${flippedAt}) * 1000000)::bigint, 'evidence', ${evidence})::text, 'UTF8')), 'hex')`;
