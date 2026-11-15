/**
 * The decision anchor redirects: where each block anchor a decision's
 * document no longer holds went. Written in the decision write's transaction
 * from the replaced and the new document (`planAnchorRedirects`), read by the
 * public redirect route. One owner for both sides.
 */

import { and, eq, sql } from "drizzle-orm";

import {
  DECISION_ANCHOR_REDIRECT,
  type DecisionAnchorRedirect,
} from "@stll/api-contract/case-law-anchor-redirects";
import {
  nextAnchorRedirects,
  planAnchorRedirects,
  type ReplacedBlockAnchor,
} from "@stll/legal-ast/anchor-redirects";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisionAnchorRedirects } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";

type AnchorRedirectExecutor = Pick<Transaction, "execute" | "select">;

const readStoredRedirects = async (
  tx: AnchorRedirectExecutor,
  decisionId: SafeId<"caseLawDecision">,
): Promise<Map<string, string | null>> =>
  new Map(
    (
      await tx
        .select({
          fromAnchor: caseLawDecisionAnchorRedirects.fromAnchor,
          toAnchor: caseLawDecisionAnchorRedirects.toAnchor,
        })
        .from(caseLawDecisionAnchorRedirects)
        .where(eq(caseLawDecisionAnchorRedirects.decisionId, decisionId))
    ).map(({ fromAnchor, toAnchor }) => [fromAnchor, toAnchor]),
  );

const sameRedirects = (
  left: ReadonlyMap<string, string | null>,
  right: ReadonlyMap<string, string | null>,
): boolean =>
  left.size === right.size &&
  [...left].every(([from, to]) => right.has(from) && right.get(from) === to);

type WriteDecisionAnchorRedirectsOptions = {
  decisionId: SafeId<"caseLawDecision">;
  /** The anchors and words of the document this write replaced. */
  replaced: readonly ReplacedBlockAnchor[];
  /** The document this write stored. */
  current: DocumentAst;
};

/**
 * Record where the replaced document's anchors went and carry the stored
 * redirects through this write. The caller holds the decision row lock, so
 * writes of one decision's redirects are serialized with its document.
 */
export const writeDecisionAnchorRedirectsTx = async (
  tx: AnchorRedirectExecutor,
  { decisionId, replaced, current }: WriteDecisionAnchorRedirectsOptions,
): Promise<void> => {
  const stored = await readStoredRedirects(tx, decisionId);
  const next = nextAnchorRedirects({
    stored,
    step: planAnchorRedirects(replaced, current),
    currentAnchors: new Set(current.blocks.map(({ anchorId }) => anchorId)),
  });
  if (sameRedirects(stored, next)) {
    return;
  }
  // audit: skip — background case-law ingestion pipeline; public case-law data, not user actions
  await tx.execute(sql`
    DELETE FROM ${caseLawDecisionAnchorRedirects}
    WHERE ${caseLawDecisionAnchorRedirects.decisionId} = ${decisionId}
  `);
  if (next.size === 0) {
    return;
  }
  const rows = [...next].map(([fromAnchor, toAnchor]) => ({
    fromAnchor,
    toAnchor,
  }));
  // audit: skip — background case-law ingestion pipeline; public case-law data, not user actions
  await tx.execute(sql`
    INSERT INTO ${caseLawDecisionAnchorRedirects} (decision_id, from_anchor, to_anchor)
    SELECT ${decisionId}::uuid, redirect."fromAnchor", redirect."toAnchor"
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb)
      AS redirect("fromAnchor" text, "toAnchor" text)
  `);
};

type ReadDecisionAnchorRedirectsOptions = {
  decisionId: SafeId<"caseLawDecision">;
  anchors: readonly string[];
};

/** What the stored redirects say about each asked anchor, in asked order. */
export const readDecisionAnchorRedirects = async (
  tx: CaseLawPublicReadTransaction,
  { decisionId, anchors }: ReadDecisionAnchorRedirectsOptions,
): Promise<{ anchor: string; redirect: DecisionAnchorRedirect }[]> => {
  const rows = await tx
    .select({
      fromAnchor: caseLawDecisionAnchorRedirects.fromAnchor,
      toAnchor: caseLawDecisionAnchorRedirects.toAnchor,
    })
    .from(caseLawDecisionAnchorRedirects)
    .where(
      and(
        eq(caseLawDecisionAnchorRedirects.decisionId, decisionId),
        sql`${caseLawDecisionAnchorRedirects.fromAnchor} IN (
          SELECT jsonb_array_elements_text(${JSON.stringify(anchors)}::text::jsonb)
        )`,
      ),
    );
  const found = new Map(
    rows.map(({ fromAnchor, toAnchor }) => [fromAnchor, toAnchor]),
  );
  return anchors.map((anchor) => {
    if (!found.has(anchor)) {
      return {
        anchor,
        redirect: { type: DECISION_ANCHOR_REDIRECT.NOT_REDIRECTED },
      };
    }
    const target = found.get(anchor) ?? null;
    return {
      anchor,
      redirect:
        target === null
          ? { type: DECISION_ANCHOR_REDIRECT.GONE }
          : { type: DECISION_ANCHOR_REDIRECT.MOVED, anchorId: target },
    };
  });
};
