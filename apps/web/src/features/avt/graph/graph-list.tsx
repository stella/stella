/**
 * The graph as a list: each document's claims, each with the facts it
 * links as chips. The same model as the canvas, for narrow screens, the
 * keyboard and screen readers.
 */

import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import { FactSource } from "@/features/avt/fact-source";
import {
  citationStroke,
  TIER_LABEL_KEYS,
} from "@/features/avt/graph/graph-canvas";
import type {
  GraphCitation,
  GraphFact,
  GraphModel,
} from "@/features/avt/graph/graph-model.logic";
import {
  claimLinks,
  unlinkedFacts,
} from "@/features/avt/graph/graph-model.logic";
import { StateSwatch } from "@/features/avt/state-chip";
import { STATE_META } from "@/features/avt/types";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";

/** How a chip names the link: what the fact does for the claim. */
const relationKey = (edge: GraphCitation) => {
  if (edge.type === "record-conflict") {
    return edge.governs
      ? "avt.graph.relation.governs"
      : "avt.graph.relation.recordConflict";
  }
  return RELATION_KEYS[edge.rel];
};

const RELATION_KEYS = {
  supports: "avt.graph.relation.supports",
  conflicts: "avt.graph.relation.conflicts",
  record: "avt.graph.relation.record",
} as const satisfies Record<
  Extract<GraphCitation, { type: "cites" }>["rel"],
  TranslationKey
>;

type GraphListProps = {
  workspaceId: string;
  model: GraphModel;
  onOpenClaim: (claim: { statementId: string; id: string }) => void;
  className?: string;
};

/** Where a chip's fact comes from: its first source, opening at the place
 *  it cites, as the canvas's source column does. */
type ChipSource = {
  documentId: string;
  documentName: string;
  locator: GraphModel["provenance"][number]["locator"];
};

export const GraphList = ({
  workspaceId,
  model,
  onOpenClaim,
  className,
}: GraphListProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const unlinked = unlinkedFacts(model);
  const sourceNames = new Map(
    model.sources.map((source) => [source.id, source.name]),
  );
  const firstSource = new Map<string, ChipSource>();
  for (const edge of model.provenance) {
    if (!firstSource.has(edge.factId)) {
      firstSource.set(edge.factId, {
        documentId: edge.sourceId,
        documentName: sourceNames.get(edge.sourceId) ?? "",
        locator: edge.locator,
      });
    }
  }
  const chip = (edge: GraphCitation | null, fact: GraphFact) => (
    <FactChip
      edge={edge}
      fact={fact}
      key={fact.id}
      source={firstSource.get(fact.id) ?? null}
      workspaceId={workspaceId}
    />
  );
  return (
    <div
      aria-label={t("avt.graph.listLabel")}
      className={cn("flex flex-col gap-6", className)}
      data-testid="avt-graph-list"
      role="region"
    >
      {model.statements.map((statement) => {
        const claims = model.claims.filter(
          (claim) => claim.statementId === statement.id,
        );
        const headingId = `avt-graph-statement-${statement.id}`;
        return (
          <section aria-labelledby={headingId} key={statement.id}>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h3
                className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]"
                id={headingId}
              >
                <BidiText>{statement.name}</BidiText>
              </h3>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {t("avt.graph.claimCount", { count: statement.claimCount })}
              </span>
            </div>
            <ul className="divide-border flex flex-col divide-y rounded-lg border">
              {claims.map((claim) => {
                const links = claimLinks(model, claim.id);
                return (
                  <li
                    className="flex flex-col gap-2 px-3 py-2.5"
                    key={claim.id}
                  >
                    <Button
                      className="-mx-1.5 block"
                      onClick={() => onOpenClaim(claim)}
                      variant="plain"
                    >
                      <span className="hover:bg-muted/60 flex items-start gap-2 rounded-md px-1.5 py-1 text-start text-sm">
                        <span className="mt-1.5">
                          <StateSwatch state={claim.state} />
                        </span>
                        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                          <span className="sr-only">
                            {t(STATE_META[claim.state].chipKey)}:{" "}
                          </span>
                          <BidiText>{claim.text}</BidiText>
                        </span>
                      </span>
                    </Button>
                    {links.length > 0 && (
                      <ul
                        aria-label={t("avt.graph.linkedFacts", {
                          count: links.length,
                        })}
                        className="flex flex-col items-start gap-1.5 ps-5"
                      >
                        {links.map(({ edge, fact }) => chip(edge, fact))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {unlinked.length > 0 && (
        <section aria-labelledby="avt-graph-unlinked">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h3
              className="text-muted-foreground text-sm font-medium"
              id="avt-graph-unlinked"
            >
              {t("avt.graph.unlinked")}
            </h3>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {format.number(unlinked.length)}
            </span>
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {unlinked.map((fact) => chip(null, fact))}
          </ul>
        </section>
      )}
    </div>
  );
};

type FactChipProps = {
  workspaceId: string;
  edge: GraphCitation | null;
  fact: GraphFact;
  source: ChipSource | null;
};

const FactChip = ({ workspaceId, edge, fact, source }: FactChipProps) => {
  const t = useTranslations();
  const notes = [
    fact.tier === "document" ? null : t(TIER_LABEL_KEYS[fact.tier]),
    fact.held ? t("avt.graph.held") : null,
    fact.listed ? null : t("avt.graph.offList"),
  ].filter((note) => note !== null);
  return (
    <li
      className={cn(
        "bg-card flex max-w-full min-w-0 flex-col gap-0.5 rounded-md border px-2 py-1 text-xs",
        (fact.held || !fact.listed) && "border-dashed",
      )}
    >
      <span className="flex min-w-0 items-baseline gap-1.5">
        {edge !== null && (
          <>
            <span
              aria-hidden="true"
              className="h-0.5 w-2.5 shrink-0 self-center rounded-full"
              style={{ backgroundColor: citationStroke(edge).color }}
            />
            <span className="text-muted-foreground shrink-0">
              {t(relationKey(edge))}
            </span>
          </>
        )}
        <BidiText
          as="span"
          className={cn(
            "line-clamp-2 min-w-0 [overflow-wrap:anywhere]",
            fact.held && "text-muted-foreground",
          )}
        >
          {fact.text}
        </BidiText>
      </span>
      {(notes.length > 0 || source !== null) && (
        <span className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1.5">
          {notes.length > 0 && <span>{notes.join(" · ")}</span>}
          {source !== null && (
            <FactSource
              documentId={source.documentId}
              documentName={source.documentName}
              locator={source.locator}
              workspaceId={workspaceId}
            />
          )}
        </span>
      )}
    </li>
  );
};
