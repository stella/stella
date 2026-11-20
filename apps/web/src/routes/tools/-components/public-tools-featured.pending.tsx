import type { ReactElement, ReactNode } from "react";

import type { CatalogueEntry } from "@stll/catalogue/schema";
import { BidiText } from "@stll/ui/bidi-text";
import { ButtonFace } from "@stll/ui/control-face";
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
import { TRUNCATED_TEXT_LINES_CLASS } from "@stll/ui/truncated-text-face";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import {
  ares,
  contractReview,
  jurisRank,
} from "@/routes/tools/-components/public-tools-featured-data.logic";
import {
  CaseLawPreview,
  CompanyRegistryPreview,
  ContractReviewPreview,
} from "@/routes/tools/-components/public-tools-featured-previews.pending";
import {
  PUBLIC_TOOL_TASK_LABEL_KEY,
  type PublicToolTask,
} from "@/routes/tools/-components/public-tools-index.logic";

type FeaturedLinkProps = {
  children: ReactNode;
  className: string;
  slug: string;
};

type FeaturedTextProps = {
  children: ReactNode;
  className: string;
};

type FeaturedToolsProps = {
  author?: ReactNode;
  help?: ReactNode;
  renderLink?: (props: FeaturedLinkProps) => ReactElement;
  renderTruncated?: (props: FeaturedTextProps) => ReactElement;
};

const renderInertLink = ({ children, className }: FeaturedLinkProps) => (
  <div className={className} inert>
    {children}
  </div>
);

const renderTruncatedFace = ({ children, className }: FeaturedTextProps) => (
  <BidiText as="p" className={cn(TRUNCATED_TEXT_LINES_CLASS[2], className)}>
    {children}
  </BidiText>
);

const featuredHelpPending = (
  <ButtonFace className="min-h-11" size="default" variant="muted">
    <CircleHelpIcon />
    <PendingText id="publicTools.discovery.howTitle" />
  </ButtonFace>
);

export function PublicToolsFeaturedFace({
  author = contractReview.author,
  help = featuredHelpPending,
  renderLink = renderInertLink,
  renderTruncated = renderTruncatedFace,
}: FeaturedToolsProps) {
  return (
    <section aria-labelledby="featured-tools-heading" className="pt-8 lg:pt-10">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <h2
          className="text-foreground text-2xl font-semibold tracking-tight text-balance"
          id="featured-tools-heading"
        >
          <PendingText id="publicTools.discovery.featuredTitle" />
        </h2>
        {help}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,0.85fr)_minmax(0,0.85fr)]">
        <FeaturedToolSurface
          className="bg-background group shadow-floating flex min-w-0 flex-col gap-5 rounded-2xl p-5 text-start transition-transform duration-150 hover:-translate-y-0.5 hover:shadow-[0_2px_5px_rgb(0_0_0/0.05),0_14px_36px_rgb(0_0_0/0.07)] sm:col-span-2 sm:p-6 xl:col-span-1"
          renderLink={renderLink}
          slug={contractReview.slug}
        >
          <div className="flex min-w-0 flex-col">
            <div className="bg-muted/60 flex size-11 items-center justify-center rounded-xl">
              <FileSearchIcon className="text-foreground size-5" />
            </div>
            <h3 className="text-foreground mt-5 text-xl font-semibold text-balance">
              <PendingText
                id={PUBLIC_TOOL_TASK_LABEL_KEY["review-agreements"]}
              />
            </h3>
            <BidiText
              as="p"
              className="text-muted-foreground mt-1 text-sm font-medium"
            >
              {contractReview.displayName}
            </BidiText>
            <Prose tone="muted" size="sm" className="mt-2">
              <PendingText id="publicTools.discovery.contractReviewBody" />
            </Prose>
            <p className="text-muted-foreground mt-4 text-xs">{author}</p>
          </div>

          <ContractReviewPreview />
          <FeaturedOpenSkill />
        </FeaturedToolSurface>

        <OutcomeToolCard
          body={<PendingText id="publicTools.discovery.jurisRankBody" />}
          entry={jurisRank}
          icon={CaseLawIcon}
          renderLink={renderLink}
          renderTruncated={renderTruncated}
          task="research-precedents"
        >
          <CaseLawPreview />
        </OutcomeToolCard>

        <OutcomeToolCard
          body={<PendingText id="publicTools.discovery.aresBody" />}
          entry={ares}
          icon={Building2Icon}
          renderLink={renderLink}
          renderTruncated={renderTruncated}
          task="verify-organizations"
        >
          <CompanyRegistryPreview jurisdictions={ares.jurisdictions} />
        </OutcomeToolCard>
      </div>
    </section>
  );
}

function FeaturedToolSurface({
  renderLink,
  ...props
}: FeaturedLinkProps & {
  renderLink: NonNullable<FeaturedToolsProps["renderLink"]>;
}) {
  return renderLink(props);
}

function OutcomeToolCard({
  body,
  children,
  entry,
  icon: Icon,
  renderLink,
  renderTruncated,
  task,
}: {
  body: ReactNode;
  children: ReactNode;
  entry: CatalogueEntry;
  icon: LucideIcon;
  renderLink: NonNullable<FeaturedToolsProps["renderLink"]>;
  renderTruncated: NonNullable<FeaturedToolsProps["renderTruncated"]>;
  task: PublicToolTask;
}) {
  return (
    <FeaturedToolSurface
      className="bg-background group hover:bg-muted/20 shadow-floating flex min-w-0 flex-col rounded-2xl p-5 text-start transition-transform duration-150 hover:-translate-y-0.5"
      renderLink={renderLink}
      slug={entry.slug}
    >
      <div className="flex items-start gap-3">
        <div className="bg-muted/60 flex size-10 shrink-0 items-center justify-center rounded-xl">
          <Icon className="text-foreground size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-foreground font-semibold text-balance">
            <PendingText id={PUBLIC_TOOL_TASK_LABEL_KEY[task]} />
          </h3>
          {renderTruncated({
            className: "text-muted-foreground mt-1 text-sm font-medium",
            children: entry.displayName,
          })}
        </div>
      </div>
      {(entry.author !== "stella" || entry.jurisdictions.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {entry.author !== "stella" && (
            <span className="text-muted-foreground text-xs">
              <PendingText id="publicTools.discovery.fromCommunity" />
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
      {renderTruncated({
        className: "text-muted-foreground mt-3 text-sm leading-6 text-pretty",
        children: body,
      })}
      <div className="mt-4">{children}</div>
      <FeaturedOpenSkill className="mt-auto pt-4" />
    </FeaturedToolSurface>
  );
}

const FeaturedOpenSkill = ({ className }: { className?: string }) => (
  <span
    className={cn(
      "text-foreground inline-flex items-center gap-2 text-sm font-medium",
      className,
    )}
  >
    <PendingText id="publicTools.discovery.openSkill" />
    <span className="inline-flex transition-opacity group-hover:opacity-70">
      <DirectionalIcon icon={ArrowRightIcon} />
    </span>
  </span>
);
