import type { ReactNode } from "react";

import { useParams } from "@tanstack/react-router";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import { TruncatedTextFace } from "@stll/ui/truncated-text-face";
import { cn } from "@stll/ui/utils";

import { usePendingCache } from "@/components/pending-cache";
import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";
import { cachedRoleGrants } from "@/lib/organization/cached-permissions.logic";
import { cachedCorrespondenceSummary } from "@/lib/workspaces/cached-correspondence.logic";
import type { CachedCorrespondenceSummary } from "@/lib/workspaces/cached-correspondence.logic";
import { framePendingView } from "@/routes/-pending-view.logic";

/**
 * The message page's frame: the header row (the way back, the subject and
 * the handling action) over the message's sections in their scroll area.
 */
export const CorrespondenceDetailShell = ({
  action,
  back,
  children,
  title,
}: {
  action: ReactNode;
  back: ReactNode;
  children: ReactNode;
  title: ReactNode;
}) => (
  <div className="flex h-full flex-col">
    <div className="flex items-center gap-3 border-b px-4 py-3">
      {back}
      <h1 className="min-w-0 flex-1 text-sm font-medium">{title}</h1>
      {action}
    </div>
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-5 p-4">{children}</div>
    </ScrollArea>
  </div>
);

/** "Back to the list": its words, in the link's touch-sized box. */
export const BackToListLabel = ({ children }: { children: ReactNode }) => (
  <span className="text-muted-foreground hover:text-foreground flex min-h-11 items-center px-2 text-sm">
    {children}
  </span>
);

/** "Mark handled" / "Mark new": the header's one action, touch-sized
 *  (`min-h-11`) in both phases. */
export const HANDLING_BUTTON = { size: "sm", variant: "outline" } as const;

/** The words the handling action reads, by the message's state. */
export const handlingActionLabelKey = (
  handlingState: CachedCorrespondenceSummary["handlingState"],
) =>
  handlingState === "new"
    ? ("correspondence.markHandled" as const)
    : ("correspondence.markNew" as const);

/** A section of the message: a bordered card, laid out by what it holds. */
export const CorrespondenceSection = ({
  children,
  layout = "stack",
}: {
  children: ReactNode;
  /** `fields` sets label and value pairs two to a row from `sm` up. */
  layout?: "stack" | "fields" | "plain";
}) => (
  <section
    className={cn(
      "rounded-lg border p-4",
      layout === "stack" && "space-y-3",
      layout === "fields" && "grid gap-4 sm:grid-cols-2",
    )}
  >
    {children}
  </section>
);

/** A section's heading inside a `fields` section: it spans both columns. */
export const FIELDS_HEADING_CLASS = "text-sm font-medium sm:col-span-2";

/** A labelled value of the message: the label over its value. */
export const DetailField = ({
  children,
  label,
}: {
  children: ReactNode;
  label: ReactNode;
}) => (
  <div className="min-w-0 space-y-1">
    <div className="text-muted-foreground text-xs">{label}</div>
    <div className="text-sm wrap-break-word">{children}</div>
  </div>
);

/** A labelled value before the read: its label's words, or a bar for a label
 *  the message decides, and a bar for the value. */
export const DetailFieldSkeleton = ({
  label,
}: {
  label: PendingTextKey | null;
}) => (
  <DetailField
    label={
      label === null ? (
        <FaceLabelPending className="w-16" />
      ) : (
        <PendingText barClassName="w-16" id={label} />
      )
    }
  >
    <FaceLabelPending className="w-40" />
  </DetailField>
);

/** The message's body: its heading over the text. */
export const BodySectionHeading = ({ children }: { children: ReactNode }) => (
  <h2 className="mb-3 text-sm font-medium">{children}</h2>
);

const BODY_LINE_WIDTHS: readonly string[] = [
  "w-full",
  "w-11/12",
  "w-4/5",
  "w-2/3",
];

const CorrespondencePendingBody = ({
  summary,
}: {
  summary: CachedCorrespondenceSummary | null;
}) => {
  const channel = summary?.channel ?? "email";
  return (
    <>
      {/* How it came in: its delivery checks, or who uploaded it. */}
      <CorrespondenceSection>
        {summary?.source === "delivery" ? (
          <h2 className="text-sm font-medium">
            <PendingText
              barClassName="w-36"
              id="correspondence.deliveryAuthentication"
            />
          </h2>
        ) : (
          <FaceLabelPending className="w-36" />
        )}
        <FaceLabelPending className="w-64" />
      </CorrespondenceSection>
      {channel === "email" ? (
        <CorrespondenceSection layout="fields">
          <DetailFieldSkeleton label={null} />
          <DetailFieldSkeleton label="emailViewer.to" />
        </CorrespondenceSection>
      ) : (
        <CorrespondenceSection>
          <FaceLabelPending className="w-36" />
          <FaceLabelPending className="w-56" />
        </CorrespondenceSection>
      )}
      <CorrespondenceSection layout="fields">
        <DetailFieldSkeleton label="correspondence.receivedAt" />
        <DetailFieldSkeleton label="common.assignee" />
      </CorrespondenceSection>
      {channel === "email" && (
        <CorrespondenceSection layout="plain">
          <BodySectionHeading>
            <PendingText barClassName="w-16" id="emailViewer.bodyTitle" />
          </BodySectionHeading>
          <div aria-hidden="true" className="space-y-2">
            {BODY_LINE_WIDTHS.map((width) => (
              <Skeleton className={cn("h-4", width)} key={width} />
            ))}
          </div>
        </CorrespondenceSection>
      )}
    </>
  );
};

/**
 * A filed message before its read: the header row and the sections its
 * channel gives it, from what the cache already holds (the matter's list, an
 * earlier visit). A message the cache has not seen draws an email's
 * sections, with bars for what the read decides.
 */
const CorrespondenceDetailPendingView = () => {
  const { correspondenceId, workspaceId } = useParams({
    strict: false,
    select: (params) => ({
      correspondenceId: params.correspondenceId,
      workspaceId: params.workspaceId,
    }),
  });
  const cache = usePendingCache();
  const summary =
    cache === null ||
    correspondenceId === undefined ||
    workspaceId === undefined
      ? null
      : cachedCorrespondenceSummary(cache, { correspondenceId, workspaceId });
  const canUpdate =
    cache !== null && cachedRoleGrants(cache, { workspace: ["update"] });
  return (
    <CorrespondenceDetailShell
      action={
        canUpdate && (
          <ButtonFace
            className="min-h-11"
            size={HANDLING_BUTTON.size}
            variant={HANDLING_BUTTON.variant}
          >
            {summary === null ? (
              <FaceLabelPending className="w-20" />
            ) : (
              <PendingText
                barClassName="w-20"
                id={handlingActionLabelKey(summary.handlingState)}
              />
            )}
          </ButtonFace>
        )
      }
      back={
        <BackToListLabel>
          <PendingText barClassName="w-24" id="correspondence.backToList" />
        </BackToListLabel>
      }
      title={
        <TruncatedTextFace>
          {summary === null || summary.subject === "" ? (
            <FaceLabelPending className="w-48" />
          ) : (
            <bdi dir="auto">{summary.subject}</bdi>
          )}
        </TruncatedTextFace>
      }
    >
      <CorrespondencePendingBody summary={summary} />
    </CorrespondenceDetailShell>
  );
};

export const CorrespondenceDetailPending = framePendingView(
  CorrespondenceDetailPendingView,
);
