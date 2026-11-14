/**
 * The Chronology of a list: its facts in the order they happened, each
 * dated only as precisely as it is known ("Mar 2021", "2021"), the undated
 * ones last. Each row says where the fact comes from and which claims rest
 * on it, with their verdicts; a claim opens the review's claim panel.
 */

import * as React from "react";

import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { useFactDateText } from "@/features/avt/fact-date";
import { FactSource } from "@/features/avt/fact-source";
import { TIER_LABEL_KEYS } from "@/features/avt/graph/graph-canvas";
import { GraphClaimSheet } from "@/features/avt/graph/graph-claim-sheet";
import type {
  ChronologyRow,
  GraphClaim,
} from "@/features/avt/graph/graph-model.logic";
import { chronologyOf } from "@/features/avt/graph/graph-model.logic";
import {
  GraphPages,
  useOpenedClaim,
  useVerificationGraphModel,
} from "@/features/avt/graph/verification-graph";
import { StateSwatch } from "@/features/avt/state-chip";
import { STATE_META } from "@/features/avt/types";
import { detached } from "@/lib/detached";

/** Claims a row names before folding the rest behind "N more". */
const CLAIMS_SHOWN = 3;

type ChronologyProps = {
  workspaceId: string;
  listId: string;
};

export const Chronology = ({ workspaceId, listId }: ChronologyProps) => {
  const t = useTranslations();
  const { query, model } = useVerificationGraphModel({ workspaceId, listId });
  const claimPanel = useOpenedClaim();

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-2">
        {["a", "b", "c", "d", "e", "f"].map((key) => (
          <Skeleton className="h-14 w-full" key={key} />
        ))}
      </div>
    );
  }
  if (model === null) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-muted-foreground">{t("common.loadFailed")}</span>
        <Button
          onClick={() => detached(query.refetch(), "avt-chronology.reload")}
          size="sm"
          variant="outline"
        >
          {t("common.reload")}
        </Button>
      </div>
    );
  }
  const groups = chronologyOf(model);
  const pages = (
    <GraphPages
      factOverflow={model.factOverflow}
      factsShown={model.facts.length}
      query={query}
    />
  );
  if (groups.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground text-sm">
          {t("avt.chronology.empty")}
        </p>
        {pages}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6" data-testid="avt-chronology">
      {groups.map((group) =>
        group.type === "dated" ? (
          <DatedRows
            key="dated"
            onOpenClaim={claimPanel.open}
            rows={group.rows}
            workspaceId={workspaceId}
          />
        ) : (
          <section aria-labelledby="avt-chronology-undated" key="undated">
            <h3
              className="text-muted-foreground mb-1 text-xs font-medium"
              id="avt-chronology-undated"
            >
              {t("avt.chronology.undated")}
            </h3>
            <ol className="divide-border flex flex-col divide-y">
              {group.rows.map((row) => (
                <ChronologyItem
                  key={row.fact.id}
                  onOpenClaim={claimPanel.open}
                  row={row}
                  workspaceId={workspaceId}
                />
              ))}
            </ol>
          </section>
        ),
      )}
      {pages}
      <GraphClaimSheet
        onClose={claimPanel.close}
        opened={claimPanel.opened}
        workspaceId={workspaceId}
      />
    </div>
  );
};

/** Dated facts under their year, so a long record reads by period. */
const DatedRows = ({
  rows,
  workspaceId,
  onOpenClaim,
}: {
  rows: readonly ChronologyRow[];
  workspaceId: string;
  onOpenClaim: (claim: GraphClaim) => void;
}) => {
  const years: { year: string; rows: ChronologyRow[] }[] = [];
  for (const row of rows) {
    const year = (row.fact.occurredOn ?? "").slice(0, 4);
    const last = years.at(-1);
    if (last?.year === year) {
      last.rows.push(row);
    } else {
      years.push({ year, rows: [row] });
    }
  }
  return (
    <>
      {years.map(({ year, rows: yearRows }) => (
        <section aria-labelledby={`avt-chronology-${year}`} key={year}>
          <h3
            className="text-muted-foreground mb-1 text-xs font-medium tabular-nums"
            id={`avt-chronology-${year}`}
          >
            {year}
          </h3>
          <ol className="divide-border flex flex-col divide-y">
            {yearRows.map((row) => (
              <ChronologyItem
                key={row.fact.id}
                onOpenClaim={onOpenClaim}
                row={row}
                workspaceId={workspaceId}
              />
            ))}
          </ol>
        </section>
      ))}
    </>
  );
};

const ChronologyItem = ({
  row,
  workspaceId,
  onOpenClaim,
}: {
  row: ChronologyRow;
  workspaceId: string;
  onOpenClaim: (claim: GraphClaim) => void;
}) => {
  const t = useTranslations();
  const dateText = useFactDateText();
  const [expanded, setExpanded] = React.useState(false);
  const { fact, sources, claims } = row;
  const date =
    fact.occurredOn === null || fact.occurredOnPrecision === null
      ? null
      : dateText(fact.occurredOn, fact.occurredOnPrecision);
  const shownClaims = expanded ? claims : claims.slice(0, CLAIMS_SHOWN);
  const notes = [
    fact.tier === "document" ? null : t(TIER_LABEL_KEYS[fact.tier]),
    fact.held ? t("avt.graph.held") : null,
  ].filter((note) => note !== null);
  return (
    <li className="grid grid-cols-1 gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[8rem_1fr]">
      <span className="text-muted-foreground text-xs tabular-nums sm:pt-0.5">
        {date ?? t("avt.chronology.undated")}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <BidiText
          as="span"
          className={cn(
            "text-sm [overflow-wrap:anywhere]",
            fact.held && "text-muted-foreground",
          )}
        >
          {fact.text}
        </BidiText>
        {(sources.length > 0 || notes.length > 0) && (
          <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
            {notes.length > 0 && <span>{notes.join(" · ")}</span>}
            {/* Every place the fact is cited opens its document there. */}
            {sources.map((source, index) => (
              <React.Fragment
                key={`${source.sourceId}|${JSON.stringify(source.locator)}`}
              >
                {(index > 0 || notes.length > 0) && (
                  <span aria-hidden="true">·</span>
                )}
                <FactSource
                  documentId={source.sourceId}
                  documentName={source.name}
                  locator={source.locator}
                  workspaceId={workspaceId}
                />
              </React.Fragment>
            ))}
          </div>
        )}
        {claims.length > 0 && (
          <ul
            aria-label={t("avt.chronology.claims", { count: claims.length })}
            className="flex flex-wrap gap-1.5"
          >
            {shownClaims.map((claim) => (
              <li className="max-w-full min-w-0" key={claim.id}>
                <Button
                  className="block max-w-md min-w-0"
                  onClick={() => onOpenClaim(claim)}
                  variant="plain"
                >
                  <span className="bg-card hover:bg-muted/60 flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs">
                    <StateSwatch state={claim.state} />
                    <span className="shrink-0 font-medium">
                      {t(STATE_META[claim.state].chipKey)}
                    </span>
                    <TruncatedText
                      className="text-muted-foreground"
                      render={<BidiText as="span" />}
                    >
                      {claim.text}
                    </TruncatedText>
                  </span>
                </Button>
              </li>
            ))}
            {claims.length > CLAIMS_SHOWN && (
              <li>
                <Button
                  onClick={() => setExpanded(!expanded)}
                  size="inline"
                  variant="muted"
                >
                  {expanded
                    ? t("common.showLess")
                    : t("avt.chronology.moreClaims", {
                        count: claims.length - CLAIMS_SHOWN,
                      })}
                </Button>
              </li>
            )}
          </ul>
        )}
      </div>
    </li>
  );
};
