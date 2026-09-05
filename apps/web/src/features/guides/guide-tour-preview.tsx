import { panic } from "better-result";
import {
  ArrowUpIcon,
  CheckIcon,
  PlusIcon,
  UploadIcon,
  ZapIcon,
} from "lucide-react";

import { PreviewPane } from "@stll/ui/preview-pane";

import { EntityKindIcon } from "@/components/workspaces/entity-kind-icon";
import {
  GUIDE_TOUR_IDS,
  type GuideTourId,
} from "@/features/guides/guide-types";

// Decorative thumbnail beside each checklist entry: an abstract depiction of
// what the tour covers, drawn from muted primitives and the app's real icons.
// It carries nothing the card's title and description do not already say, so
// `PreviewPane` hides it from assistive technology and it holds no focusable
// or interactive element.
//
// No text: at thumbnail size a label is unreadable, which also keeps the
// depictions free of per-language i18n debt (sample content in a preview is
// mock user data, not interface copy).
export const GuideTourPreview = ({ tourId }: { tourId: GuideTourId }) => (
  <PreviewPane
    aria-hidden="true"
    className="hidden shrink-0 sm:block"
    size="thumbnail"
  >
    <GuideTourCanvas tourId={tourId} />
  </PreviewPane>
);

// Exhaustive over the closed tour union: a new tour without a depiction fails
// typecheck here rather than rendering an empty pane.
const GuideTourCanvas = ({ tourId }: { tourId: GuideTourId }) => {
  switch (tourId) {
    case GUIDE_TOUR_IDS.chat:
      return <ChatPreview />;
    case GUIDE_TOUR_IDS.documents:
      return <DocumentsPreview />;
    case GUIDE_TOUR_IDS.playbooks:
      return <PlaybooksPreview />;
    case GUIDE_TOUR_IDS.workflows:
      return <WorkflowsPreview />;
    case GUIDE_TOUR_IDS.tabularReview:
      return <TabularReviewPreview />;
    default:
      tourId satisfies never;
      return panic(`Unhandled tour id: ${String(tourId)}`);
  }
};

// A request, its answer, and the composer that sent it: the (+) affordance on
// one end, send on the other.
const ChatPreview = () => (
  <div className="flex h-full flex-col justify-end gap-1">
    <div className="bg-muted-foreground/25 ms-auto h-1.5 w-14 rounded-full" />
    <div className="bg-muted h-1.5 w-full rounded-full" />
    <div className="bg-muted mb-1 h-1.5 w-3/5 rounded-full" />
    <div className="bg-card flex items-center gap-1 rounded-sm border p-1">
      <PlusIcon className="text-muted-foreground size-3 shrink-0" />
      <div className="bg-muted h-1 flex-1 rounded-full" />
      <ArrowUpIcon className="text-muted-foreground size-3 shrink-0" />
    </div>
  </div>
);

// A drop target above the files it lands in.
const DocumentsPreview = () => (
  <div className="flex h-full flex-col justify-center gap-1.5">
    <div className="border-border/70 flex items-center gap-1 rounded-sm border border-dashed p-1">
      <UploadIcon className="text-muted-foreground size-3 shrink-0" />
      <div className="bg-muted h-1 w-10 rounded-full" />
    </div>
    <div className="flex items-center gap-1.5">
      <EntityKindIcon
        className="text-muted-foreground size-3 shrink-0"
        kind="document"
      />
      <div className="bg-muted h-1 w-16 rounded-full" />
    </div>
    <div className="flex items-center gap-1.5">
      <EntityKindIcon
        className="text-muted-foreground size-3 shrink-0"
        kind="folder"
      />
      <div className="bg-muted h-1 w-12 rounded-full" />
    </div>
  </div>
);

// Review steps, two settled and one still open.
const PlaybooksPreview = () => (
  <div className="flex h-full flex-col justify-center gap-1.5">
    <div className="flex items-center gap-1.5">
      <PlaybookCheck />
      <div className="bg-muted h-1 w-16 rounded-full" />
    </div>
    <div className="flex items-center gap-1.5">
      <PlaybookCheck />
      <div className="bg-muted h-1 w-20 rounded-full" />
    </div>
    <div className="flex items-center gap-1.5">
      <span className="border-border size-3.5 shrink-0 rounded-sm border" />
      <div className="bg-muted h-1 w-12 rounded-full" />
    </div>
  </div>
);

const PlaybookCheck = () => (
  <span className="bg-muted text-muted-foreground flex size-3.5 shrink-0 items-center justify-center rounded-sm">
    <CheckIcon className="size-2.5" />
  </span>
);

// Three steps wired into one run.
const WorkflowsPreview = () => (
  <div className="flex h-full items-center">
    <WorkflowStep />
    <span className="bg-border h-px w-2 shrink-0" />
    <WorkflowStep />
    <span className="bg-border h-px w-2 shrink-0" />
    <WorkflowStep />
  </div>
);

const WorkflowStep = () => (
  <div className="bg-card flex min-w-0 flex-1 flex-col items-center gap-1 rounded-sm border p-1">
    <ZapIcon className="text-muted-foreground size-3 shrink-0" />
    <div className="bg-muted h-1 w-full rounded-full" />
  </div>
);

// One question per column, answered down every row; the dashed column is the
// next one waiting to be added.
const TabularReviewPreview = () => (
  <div className="flex h-full items-stretch gap-1">
    <div className="flex flex-1 flex-col gap-1">
      <div className="grid grid-cols-3 gap-1 border-b pb-1">
        <div className="bg-muted-foreground/30 h-1 rounded-full" />
        <div className="bg-muted-foreground/30 h-1 rounded-full" />
        <div className="bg-muted-foreground/30 h-1 rounded-full" />
      </div>
      <TabularRow />
      <TabularRow />
      <TabularRow />
    </div>
    <div className="border-border/70 flex w-6 shrink-0 items-center justify-center rounded-sm border border-dashed">
      <PlusIcon className="text-muted-foreground size-3" />
    </div>
  </div>
);

const TabularRow = () => (
  <div className="grid grid-cols-3 items-center gap-1">
    <div className="bg-muted h-1 rounded-full" />
    <div className="bg-muted h-1 rounded-full" />
    <div className="bg-muted h-1 rounded-full" />
  </div>
);
