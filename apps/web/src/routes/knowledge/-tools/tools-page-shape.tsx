import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending, InputFace } from "@stll/ui/control-face";
import { ChevronDownIcon, GlobeIcon, PlusIcon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";
import {
  ResponsiveActionToolbar,
  ResponsiveActionToolbarItem,
} from "@stll/workspace-ui/responsive-action-toolbar";

import { PendingText } from "@/components/pending-text";
import { TOOLS_CATALOGUE_KIND_LABEL_KEYS } from "@/features/knowledge/views/tools/tools-catalogue-kinds.logic";

// The Tools page's shape: light presentational pieces only (a pending-safe
// module, see .oxlint-plugins/route-pending-component-policy.json), so the
// pending views draw them before any provider mounts.

/**
 * The Tools page's one layout: its heading and description over the list.
 * The organization's page, the published list and their pending phase all
 * draw it, so the heading stays put while the list loads behind it.
 */
export const ToolsPageShell = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-col p-6">
    <div className="mb-6 flex flex-col gap-1">
      <h1 className="text-foreground text-xl font-semibold">
        <PendingText barClassName="w-16" id="knowledge.sections.tools.title" />
      </h1>
      {/* A div, not a p: the bar PendingText draws before intl mounts is a
          block, which a paragraph cannot hold, so the parser would split it
          and the page would not hydrate. */}
      <div className="text-muted-foreground text-sm">
        <PendingText
          barClassName="w-80 max-w-full"
          id="knowledge.sections.tools.description"
        />
      </div>
    </div>
    {children}
  </div>
);

const CATALOGUE_ROW_KEYS = ["a", "b", "c", "d", "e", "f"];

// Mirrors the catalogue view body (toolbar row, filter pills, then a stack of
// bordered entry cards) so the page's chrome stays put and only the catalogue
// values stream in. The add action is there where the member's role may add
// tools of their own.
export const ToolsCatalogueSkeleton = ({
  addAction = false,
}: {
  addAction?: boolean | undefined;
}) => (
  <div className="flex flex-col gap-6">
    <ResponsiveActionToolbar>
      <ResponsiveActionToolbarItem slot="primary">
        <InputFace className="min-h-11 sm:min-h-0" fieldClassName="max-sm:h-11">
          <PendingText
            barClassName="w-40"
            id="onboarding.catalogueSearchPlaceholder"
          />
        </InputFace>
      </ResponsiveActionToolbarItem>
      <ResponsiveActionToolbarItem slot="secondary">
        <ButtonFace
          className="h-11 w-full justify-start sm:h-8 sm:w-auto"
          size="default"
          variant="outline"
        >
          <GlobeIcon className="size-3.5" />
          <FaceLabelPending className="w-10" />
          <ChevronDownIcon className="size-3.5" />
        </ButtonFace>
      </ResponsiveActionToolbarItem>
      {addAction && (
        <ResponsiveActionToolbarItem slot="action">
          <ButtonFace className="h-11 sm:h-8" size="default" variant="default">
            <PlusIcon className="size-3.5" />
            <PendingText barClassName="w-20" id="catalogue.addCustom" />
            <ChevronDownIcon className="size-3.5" />
          </ButtonFace>
        </ResponsiveActionToolbarItem>
      )}
    </ResponsiveActionToolbar>

    <div className="flex items-center gap-1.5">
      {Object.values(TOOLS_CATALOGUE_KIND_LABEL_KEYS).map((label) => (
        <ButtonFace key={label} size="xs" variant="muted">
          <PendingText barClassName="w-10" id={label} />
        </ButtonFace>
      ))}
    </div>

    <div className="flex flex-col gap-2">
      <Skeleton className="mb-1 h-3 w-28" />
      {CATALOGUE_ROW_KEYS.map((key) => (
        <div className="flex items-start gap-3 rounded-lg border p-3" key={key}>
          <Skeleton className="mt-0.5 size-6 shrink-0 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex min-h-6 items-center gap-2">
              <Skeleton className="h-4 w-40" />
            </div>
            <Skeleton className="h-3 w-3/4" />
            <div className="flex flex-wrap items-center gap-1.5">
              <Skeleton className="h-5 w-12 rounded-md" />
              <Skeleton className="h-5 w-16 rounded-md" />
            </div>
          </div>
        </div>
      ))}
    </div>
  </div>
);
