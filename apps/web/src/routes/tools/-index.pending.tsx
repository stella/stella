import type { ReactNode, Ref } from "react";

import { useSearch } from "@tanstack/react-router";

import { ButtonFace, InputFace } from "@stll/ui/control-face";
import {
  Building2Icon,
  CaseLawIcon,
  FileOutputIcon,
  FileSearchIcon,
  type LucideIcon,
  PlusIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
} from "@stll/ui/icons";
import { Prose } from "@stll/ui/prose";
import { InlineSkeleton } from "@stll/ui/skeleton";
import { TruncatedTextFace } from "@stll/ui/truncated-text-face";

import { PendingText, type PendingTextKey } from "@/components/pending-text";
import type { ToolsKindFilter } from "@/lib/tools-catalogue";
import { framePendingView } from "@/routes/-pending-view.logic";
import { PublicToolsFeaturedFace } from "@/routes/tools/-components/public-tools-featured.pending";
import {
  PUBLIC_TOOL_GROUPS,
  PUBLIC_TOOL_TASK_LABEL_KEY,
  PUBLIC_TOOL_TASKS,
  type PublicToolGroup,
  type PublicToolTask,
} from "@/routes/tools/-components/public-tools-index.logic";
import { ToolCatalogueCardPending } from "@/routes/tools/-components/tool-catalogue-card.pending";

const PUBLIC_TOOLS_TASK_CLASS =
  "bg-muted/45 hover:bg-muted/70 h-11 min-w-0 justify-start";

const TASK_ICON = {
  "prepare-documents": FileOutputIcon,
  "protect-client-data": ShieldCheckIcon,
  "research-precedents": CaseLawIcon,
  "review-agreements": FileSearchIcon,
  "verify-organizations": Building2Icon,
} as const satisfies Record<PublicToolTask, LucideIcon>;

const GROUP_LABEL_KEY = {
  "data-sources": "publicTools.discovery.groups.dataSources",
  included: "publicTools.discovery.groups.included",
  skills: "catalogue.filter.skills",
} as const satisfies Record<PublicToolGroup, PendingTextKey>;

const GROUP_BODY_KEY = {
  "data-sources": "publicTools.discovery.groups.dataSourcesBody",
  included: "publicTools.discovery.groups.includedBody",
  skills: "publicTools.discovery.groups.skillsBody",
} as const satisfies Record<PublicToolGroup, PendingTextKey>;

type PublicToolsIndexShellProps = {
  children: ReactNode;
  featured: ReactNode;
  renderTask: (props: {
    className: string;
    icon: ReactNode;
    label: ReactNode;
    task: PublicToolTask;
  }) => ReactNode;
  resultsActions: ReactNode;
  resultsRef?: Ref<HTMLElement>;
  search: ReactNode;
  toolbar: ReactNode;
};

export function PublicToolsIndexShell({
  children,
  featured,
  renderTask,
  resultsActions,
  resultsRef,
  search,
  toolbar,
}: PublicToolsIndexShellProps) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
        <section className="pb-4">
          <div className="max-w-3xl">
            <h1 className="text-foreground max-w-2xl text-3xl leading-tight font-semibold tracking-tight text-balance">
              <PendingText
                barClassName="w-64 max-w-full"
                id="publicTools.discovery.heroTitle"
              />
            </h1>
            <Prose tone="muted" size="lede" className="mt-2">
              <PendingText
                barClassName="w-72 max-w-full"
                id="publicTools.discovery.heroBody"
              />
            </Prose>
          </div>
          <div className="mt-6 max-w-3xl">{search}</div>
          <div className="mt-5">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              <PendingText id="publicTools.discovery.tasksTitle" />
            </p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {PUBLIC_TOOL_TASKS.map((task) => {
                const Icon = TASK_ICON[task];
                return renderTask({
                  className: PUBLIC_TOOLS_TASK_CLASS,
                  icon: <Icon className="text-muted-foreground" />,
                  label: <PendingText id={PUBLIC_TOOL_TASK_LABEL_KEY[task]} />,
                  task,
                });
              })}
            </div>
          </div>
        </section>

        {featured}

        <section
          aria-labelledby="all-tools-heading"
          className="scroll-mt-4 pt-10 lg:pt-12"
          ref={resultsRef}
        >
          <div className="flex flex-col gap-5">
            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <h2
                  className="text-foreground text-2xl font-semibold tracking-tight"
                  id="all-tools-heading"
                >
                  <PendingText id="publicTools.discovery.allTitle" />
                </h2>
                <Prose tone="muted" size="sm" className="mt-1">
                  <PendingText
                    barClassName="w-56 max-w-full"
                    id="publicTools.discovery.allBody"
                  />
                </Prose>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {resultsActions}
              </div>
            </div>
            {toolbar}
          </div>
          {children}
        </section>
      </div>
    </main>
  );
}

export function CatalogueGroupShell({
  children,
  group,
}: {
  children: ReactNode;
  group: PublicToolGroup;
}) {
  return (
    <section aria-labelledby={`catalogue-group-${group}`}>
      <div className="mb-4 max-w-2xl">
        <h3
          className="text-foreground text-lg font-semibold"
          id={`catalogue-group-${group}`}
        >
          <PendingText id={GROUP_LABEL_KEY[group]} />
        </h3>
        <Prose tone="muted" size="sm" className="mt-1">
          <PendingText
            barClassName="w-52 max-w-full"
            id={GROUP_BODY_KEY[group]}
          />
        </Prose>
      </div>
      <div className="grid gap-3 md:grid-cols-2">{children}</div>
    </section>
  );
}

const GROUPS_BY_KIND = {
  all: PUBLIC_TOOL_GROUPS,
  skill: ["skills"],
  mcp: ["data-sources"],
  "native-tool": ["data-sources", "included"],
} as const satisfies Record<ToolsKindFilter, readonly PublicToolGroup[]>;

export const PublicToolsIndexPending = framePendingView(() => {
  const kind = useSearch({
    strict: false,
    select: (search) => search.kind ?? "all",
  });

  return (
    <PublicToolsIndexShell
      featured={kind === "all" && <PublicToolsFeaturedFace />}
      renderTask={({ className, icon, label, task }) => (
        <ButtonFace
          className={className}
          key={task}
          size="default"
          variant="ghost"
        >
          {icon}
          <TruncatedTextFace>{label}</TruncatedTextFace>
        </ButtonFace>
      )}
      resultsActions={
        <>
          <InlineSkeleton className="h-3 w-16" />
          <ButtonFace className="min-h-11" size="default" variant="ghost">
            <PlusIcon />
            <PendingText id="publicTools.addSkill" />
          </ButtonFace>
        </>
      }
      search={
        <div className="rounded-lg shadow-xs">
          <InputFace className="min-h-12">
            <span className="text-base">
              <PendingText id="publicTools.discovery.searchPlaceholder" />
            </span>
          </InputFace>
        </div>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <ButtonFace className="min-h-11" size="default" variant="ghost">
            <SlidersHorizontalIcon />
            <PendingText id="common.filter" />
          </ButtonFace>
          {kind !== "all" && (
            <ButtonFace className="min-h-11" size="default" variant="ghost">
              <PendingText id="common.showAll" />
            </ButtonFace>
          )}
        </div>
      }
    >
      <div aria-hidden="true" className="mt-8 flex flex-col gap-10">
        {GROUPS_BY_KIND[kind].map((group) => (
          <CatalogueGroupShell group={group} key={group}>
            <ToolCatalogueCardPending />
            <ToolCatalogueCardPending />
          </CatalogueGroupShell>
        ))}
      </div>
    </PublicToolsIndexShell>
  );
});
