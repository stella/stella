import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import aresManifest from "@stll/catalogue/entries/native-tools/ares/manifest.json";
import contractReviewManifest from "@stll/catalogue/entries/skills/contract-review-anthropic/manifest.json";
import jurisRankManifest from "@stll/catalogue/entries/skills/jurisrank/manifest.json";
import { parseCatalogueEntry } from "@stll/catalogue/schema";
import type { CatalogueEntry } from "@stll/catalogue/schema";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import {
  ArrowRightIcon,
  Building2Icon,
  CaseLawIcon,
  CircleHelpIcon,
  FileSearchIcon,
  type LucideIcon,
} from "@stll/ui/icons";
import { Prose } from "@stll/ui/prose";
import { cn } from "@stll/ui/utils";

import Tooltip from "@/components/tooltip";
import {
  PUBLIC_TOOL_TASK_LABEL_KEY,
  type PublicToolTask,
} from "@/routes/tools/-components/public-tools-index.logic";

// The catalogue page and its pending view both render these cards, and the
// pending view renders before the catalogue chunk loads. So the three entries
// come from their own manifests, through the parse the catalogue applies,
// rather than from the whole loaded catalogue.
const contractReview = parseCatalogueEntry(contractReviewManifest);
const jurisRank = parseCatalogueEntry(jurisRankManifest);
const ares = parseCatalogueEntry(aresManifest);

export function PublicToolsFeatured() {
  const t = useTranslations();

  return (
    <section aria-labelledby="featured-tools-heading" className="pt-8 lg:pt-10">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <h2
          className="text-foreground text-2xl font-semibold tracking-tight text-balance"
          id="featured-tools-heading"
        >
          {t("publicTools.discovery.featuredTitle")}
        </h2>
        <Tooltip
          className="max-w-72 whitespace-normal"
          content={t("publicTools.discovery.howBody")}
          render={<Button className="min-h-11" type="button" variant="muted" />}
        >
          <CircleHelpIcon />
          {t("publicTools.discovery.howTitle")}
        </Tooltip>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,0.85fr)_minmax(0,0.85fr)]">
        <Link
          className="bg-background group shadow-floating flex min-w-0 flex-col gap-5 rounded-2xl p-5 text-start transition-transform duration-150 hover:-translate-y-0.5 hover:shadow-[0_2px_5px_rgb(0_0_0/0.05),0_14px_36px_rgb(0_0_0/0.07)] sm:col-span-2 sm:p-6 xl:col-span-1"
          from="/tools/"
          params={{ slug: contractReview.slug }}
          to="/tools/$slug"
        >
          <div className="flex min-w-0 flex-col">
            <div className="bg-muted/60 flex size-11 items-center justify-center rounded-xl">
              <FileSearchIcon className="text-foreground size-5" />
            </div>
            <h3 className="text-foreground mt-5 text-xl font-semibold text-balance">
              {t(PUBLIC_TOOL_TASK_LABEL_KEY["review-agreements"])}
            </h3>
            <BidiText
              as="p"
              className="text-muted-foreground mt-1 text-sm font-medium"
            >
              {contractReview.displayName}
            </BidiText>
            <Prose tone="muted" size="sm" className="mt-2">
              {t("publicTools.discovery.contractReviewBody")}
            </Prose>
            <p className="text-muted-foreground mt-4 text-xs">
              {t("catalogue.by", { author: contractReview.author })}
            </p>
          </div>

          <PreviewFrame label={t("publicTools.discovery.exampleReview")}>
            <div className="flex flex-col gap-2">
              <ReviewClause
                label={t("publicTools.discovery.review.liabilityCap")}
                status={t("publicTools.discovery.review.outsidePlaybook")}
                tone="attention"
              />
              <ReviewClause
                label={t("publicTools.discovery.review.termination")}
                status={t("publicTools.discovery.review.aligned")}
                tone="clear"
              />
              <ReviewClause
                label={t("publicTools.discovery.review.governingLaw")}
                status={t("publicTools.discovery.review.missing")}
                tone="attention"
              />
            </div>
          </PreviewFrame>
          <span className="text-foreground inline-flex items-center gap-2 text-sm font-medium">
            {t("publicTools.discovery.openSkill")}
            <DirectionalIcon
              className="transition-opacity group-hover:opacity-70"
              icon={ArrowRightIcon}
            />
          </span>
        </Link>

        <OutcomeToolCard
          body={t("publicTools.discovery.jurisRankBody")}
          entry={jurisRank}
          icon={CaseLawIcon}
          task="research-precedents"
        >
          <PreviewFrame label={t("common.preview")}>
            <div aria-hidden="true" className="flex flex-col gap-2.5">
              <RankPreviewRow rank="1" widthClassName="w-full" />
              <RankPreviewRow rank="2" widthClassName="w-4/5" />
              <RankPreviewRow rank="3" widthClassName="w-3/5" />
            </div>
          </PreviewFrame>
        </OutcomeToolCard>

        <OutcomeToolCard
          body={t("publicTools.discovery.aresBody")}
          entry={ares}
          icon={Building2Icon}
          task="verify-organizations"
        >
          <PreviewFrame label={t("common.preview")}>
            <div aria-hidden="true" className="flex items-center gap-3">
              <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
                <Building2Icon className="text-muted-foreground size-4" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <span className="bg-foreground/10 h-2 w-3/4 rounded-full" />
                <span className="bg-foreground/5 h-2 w-1/2 rounded-full" />
              </div>
              {ares.jurisdictions.map((code) => (
                <span
                  className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-xs"
                  key={code}
                >
                  <bdi>{code}</bdi>
                </span>
              ))}
            </div>
          </PreviewFrame>
        </OutcomeToolCard>
      </div>
    </section>
  );
}

function OutcomeToolCard({
  body,
  children,
  entry,
  icon: Icon,
  task,
}: {
  body: string;
  children: ReactNode;
  entry: CatalogueEntry;
  icon: LucideIcon;
  task: PublicToolTask;
}) {
  const t = useTranslations();

  return (
    <Link
      className="bg-background group hover:bg-muted/20 shadow-floating flex min-w-0 flex-col rounded-2xl p-5 text-start transition-transform duration-150 hover:-translate-y-0.5"
      from="/tools/"
      params={{ slug: entry.slug }}
      to="/tools/$slug"
    >
      <div className="flex items-start gap-3">
        <div className="bg-muted/60 flex size-10 shrink-0 items-center justify-center rounded-xl">
          <Icon className="text-foreground size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-foreground font-semibold text-balance">
            {t(PUBLIC_TOOL_TASK_LABEL_KEY[task])}
          </h3>
          <BidiText
            as="p"
            className="text-muted-foreground mt-1 line-clamp-2 text-sm font-medium"
          >
            {entry.displayName}
          </BidiText>
        </div>
      </div>
      {(entry.author !== "stella" || entry.jurisdictions.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {entry.author !== "stella" && (
            <span className="text-muted-foreground text-xs">
              {t("publicTools.discovery.fromCommunity")}
            </span>
          )}
          {entry.jurisdictions.map((code) => (
            <span
              className="bg-muted/50 text-muted-foreground rounded-md px-1.5 py-0.5 text-xs"
              key={code}
            >
              <bdi>{code}</bdi>
            </span>
          ))}
        </div>
      )}
      <BidiText
        as="p"
        className="text-muted-foreground mt-3 line-clamp-2 text-sm leading-6 text-pretty"
      >
        {body}
      </BidiText>
      <div className="mt-4">{children}</div>
      <span className="text-foreground mt-auto inline-flex items-center gap-2 pt-4 text-sm font-medium">
        {t("publicTools.discovery.openSkill")}
        <DirectionalIcon
          className="transition-opacity group-hover:opacity-70"
          icon={ArrowRightIcon}
        />
      </span>
    </Link>
  );
}

function RankPreviewRow({
  rank,
  widthClassName,
}: {
  rank: string;
  widthClassName: "w-3/5" | "w-4/5" | "w-full";
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-muted-foreground w-4 text-xs tabular-nums">
        {rank}
      </span>
      <span
        className={cn("bg-foreground/10 h-2 rounded-full", widthClassName)}
      />
    </div>
  );
}

function PreviewFrame({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="bg-background/75 self-stretch rounded-xl p-4 shadow-[inset_0_0_0_1px_rgb(0_0_0/0.025)]">
      <p className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
        {label}
      </p>
      {children}
    </div>
  );
}

function ReviewClause({
  label,
  status,
  tone,
}: {
  label: string;
  status: string;
  tone: "attention" | "clear";
}) {
  return (
    <div className="bg-muted/45 flex items-center justify-between gap-3 rounded-lg px-3 py-2.5">
      <span className="text-foreground text-xs font-medium">{label}</span>
      <span
        className={cn(
          tone === "clear"
            ? "text-success text-xs"
            : "text-warning-foreground text-xs",
        )}
      >
        {status}
      </span>
    </div>
  );
}
