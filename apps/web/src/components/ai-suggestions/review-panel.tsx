/**
 * Review panel — right-side surface listing the AI's pending DOCX
 * suggestions for the active document. Lawyers cycle through them
 * by severity / area, accept or reject each in place, and the
 * underlying tracked changes are resolved on the editor.
 */

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, RefObject } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CheckIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { diffWordSegments } from "@stll/folio";
import type { DocxEditorRef, FolioAIBlockPreviewRun } from "@stll/folio";
import { Avatar, AvatarFallback } from "@stll/ui/components/avatar";
import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import { Input } from "@stll/ui/components/input";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import {
  REVIEW_UNSPECIFIED_AREA,
  SEVERITY_ORDER,
  computeInitialsFrom,
  filterReviewSuggestions,
  getReviewApplyMode,
  useReviewStore,
} from "@/components/ai-suggestions/review-store";
import type {
  ReviewSeverityKey,
  ReviewSuggestion,
  ReviewSuggestionPreview,
} from "@/components/ai-suggestions/review-store";
import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { sessionOptions } from "@/routes/-queries";
import {
  getWordEditAuthorName,
  getWordEditShortcut,
} from "@/routes/_protected.chat/-hooks/use-chat-user-context";

const EMPTY_SUGGESTIONS: readonly ReviewSuggestion[] = [];

type GroupAxis = "severity" | "area";

type ReviewPanelProps = {
  entityId: string;
  docxEditorRef: RefObject<DocxEditorRef | null>;
  /** Whether the editor currently accepts edit operations. */
  docxEditable: boolean;
  /**
   * Prompt the user to unlock the document. Resolves to true on
   * success, false if the user cancels. Called by the panel when
   * the user accepts a suggestion while the editor is locked.
   */
  requestDocxEditMode?: (() => boolean | Promise<boolean>) | undefined;
  /**
   * When `true`, the panel skips its own outer chrome (title row +
   * dismiss button) so it can drop cleanly into a host that
   * provides its own header — currently the inspector tab's facet
   * bar. The filter/apply controls and the list still render.
   */
  embedded?: boolean | undefined;
};

type SeverityTone = { dot: string; chip: string; chipActive: string };

// Severity colour swatches. Each pair has a `dark:` variant so the
// rule that flags hardcoded colours in object property values is a
// false positive here; suppressed at the constant declarations
// rather than inside the object so reformatting can't split the
// suppression away from the value.
const HIGH_DOT = "bg-red-500";
const HIGH_CHIP = "border-red-500/30 text-red-700 dark:text-red-300";
const HIGH_CHIP_ACTIVE =
  "bg-red-500/10 border-red-500 text-red-700 dark:text-red-200";

const MEDIUM_DOT = "bg-amber-500";
const MEDIUM_CHIP = "border-amber-500/30 text-amber-700 dark:text-amber-300";
const MEDIUM_CHIP_ACTIVE =
  "bg-amber-500/10 border-amber-500 text-amber-700 dark:text-amber-200";

const LOW_DOT = "bg-sky-500";
const LOW_CHIP = "border-sky-500/30 text-sky-700 dark:text-sky-300";
const LOW_CHIP_ACTIVE =
  "bg-sky-500/10 border-sky-500 text-sky-700 dark:text-sky-200";

const severityTone = (severity: ReviewSeverityKey): SeverityTone => {
  switch (severity) {
    case "high":
      return { dot: HIGH_DOT, chip: HIGH_CHIP, chipActive: HIGH_CHIP_ACTIVE };
    case "medium":
      return {
        dot: MEDIUM_DOT,
        chip: MEDIUM_CHIP,
        chipActive: MEDIUM_CHIP_ACTIVE,
      };
    case "low":
      return { dot: LOW_DOT, chip: LOW_CHIP, chipActive: LOW_CHIP_ACTIVE };
    case "unspecified":
      return {
        dot: "bg-muted-foreground",
        chip: "border-border text-muted-foreground",
        chipActive: "bg-muted border-border text-foreground",
      };
    default:
      severity satisfies never;
      return { dot: "", chip: "", chipActive: "" };
  }
};

export const ReviewPanel = ({
  entityId,
  docxEditorRef,
  docxEditable,
  requestDocxEditMode,
  embedded = false,
}: ReviewPanelProps) => {
  const t = useTranslations();
  const severityLabels = useSeverityLabels();

  // The selector must return a stable reference for the same
  // input state — `?? []` creates a fresh array each call, which
  // makes useSyncExternalStore fire forever. `EMPTY_SUGGESTIONS` is
  // a module-level singleton so no-session reads share one array.
  const suggestions =
    useReviewStore((state) => state.sessions[entityId]) ?? EMPTY_SUGGESTIONS;
  const applyMode = useReviewStore((state) =>
    getReviewApplyMode(state, entityId),
  );
  const updateSuggestion = useReviewStore((state) => state.updateSuggestion);
  const setStatusBatch = useReviewStore((state) => state.setStatusBatch);
  const setApplyMode = useReviewStore((state) => state.setApplyMode);
  const dismissPanel = useReviewStore((state) => state.dismissPanel);
  const hideAccepted = useReviewStore((state) => state.hideAccepted);
  const setHideAccepted = useReviewStore((state) => state.setHideAccepted);
  // Tracked-change author + initials live on the user table
  // (preferredName / wordEditShortcut). The popover next to
  // "Tracked changes" exposes them read-only with a deep link to
  // account settings — single source of truth, no in-panel state.
  const user = useRouteContext({
    from: "/_protected",
    select: (ctx) => ({
      name: ctx.user.name ?? null,
      preferredName: ctx.user.preferredName ?? null,
      wordEditShortcut: ctx.user.wordEditShortcut ?? null,
    }),
  });
  const wordAuthor = getWordEditAuthorName(user);
  const wordShortcut =
    getWordEditShortcut(user) || computeInitialsFrom(wordAuthor);

  const [groupAxis, setGroupAxis] = useState<GroupAxis>("severity");
  const [filter, setFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(
    () =>
      filterReviewSuggestions(suggestions, { hideAccepted, filter, groupAxis }),
    [suggestions, hideAccepted, filter, groupAxis],
  );

  const groups = useMemo(() => {
    const groupTone = (items: readonly ReviewSuggestion[]): SeverityTone => {
      const highest = SEVERITY_ORDER.find((sev) =>
        items.some((item) => item.severity === sev),
      );
      return severityTone(highest ?? "unspecified");
    };

    if (groupAxis === "severity") {
      const buckets = new Map<ReviewSeverityKey, ReviewSuggestion[]>();
      for (const item of filtered) {
        const list = buckets.get(item.severity) ?? [];
        list.push(item);
        buckets.set(item.severity, list);
      }
      return SEVERITY_ORDER.flatMap((sev) => {
        const list = buckets.get(sev);
        return list && list.length > 0
          ? [
              {
                key: sev as string,
                label: severityLabels[sev],
                items: list,
                tone: severityTone(sev),
              },
            ]
          : [];
      });
    }

    const buckets = new Map<string, ReviewSuggestion[]>();
    for (const item of filtered) {
      const list = buckets.get(item.area) ?? [];
      list.push(item);
      buckets.set(item.area, list);
    }
    const sortedKeys = [...buckets.keys()].toSorted((a, b) => {
      if (a === REVIEW_UNSPECIFIED_AREA) {
        return 1;
      }
      if (b === REVIEW_UNSPECIFIED_AREA) {
        return -1;
      }
      return a.localeCompare(b);
    });
    return sortedKeys.map((area) => {
      const items = buckets.get(area) ?? [];
      const label =
        area === REVIEW_UNSPECIFIED_AREA
          ? t("docxReview.areaUnspecified")
          : area;
      return { key: area, label, items, tone: groupTone(items) };
    });
  }, [filtered, groupAxis, severityLabels, t]);

  const pendingCount = suggestions.filter((s) => s.status === "pending").length;
  const total = suggestions.length;
  const reviewedCount = total - pendingCount;

  if (total === 0) {
    return null;
  }

  const ensureUnlocked = async (): Promise<boolean> => {
    if (docxEditable) {
      return true;
    }
    if (!requestDocxEditMode) {
      return false;
    }
    return await requestDocxEditMode();
  };

  /**
   * Apply a single pending operation. Returns the resulting
   * status the store should record, plus the revisionIds on
   * success in tracked-changes mode (a replace produces two ids,
   * an insert/delete one).
   */
  const applyPending = (
    item: ReviewSuggestion,
  ): {
    status: "accepted" | "skipped";
    revisionIds: readonly number[] | null;
    skipReason?: string;
  } => {
    const editor = docxEditorRef.current;
    const op = item.pendingOperation;
    if (!editor || !op) {
      return {
        status: "skipped",
        revisionIds: null,
        skipReason: "documentNotEditable",
      };
    }

    // Use the snapshot the AI saw when it generated this op, NOT a
    // fresh one off the live editor. Block ids are sequential and
    // get renumbered after any insertAfterBlock accept; resolving
    // a queued op against the recomputed snapshot would map
    // "b-0042" to a different block than the AI intended. Falling
    // back to a live snapshot only if the AI op shipped without
    // one (legacy/test flows).
    const snapshot = item.snapshot ?? editor.createAIEditSnapshot();
    if (!snapshot) {
      return {
        status: "skipped",
        revisionIds: null,
        skipReason: "documentNotEditable",
      };
    }

    const result = editor.applyAIEditOperations({
      mode: applyMode,
      operations: [op],
      snapshot,
      // Author the tracked-change marks as the user (their preferred
      // name from account settings) — they're reviewing and
      // accepting the AI's suggestion AS THEMSELVES, not as "AI".
      // TODO: also surface `wordShortcut` as `<w:initials>` once the
      // folio DOCX writer is plumbed for it (mark schema + serializer).
      ...(wordAuthor.length > 0 && { author: wordAuthor }),
    });
    const applied = result.applied.at(0);
    if (applied) {
      return {
        status: "accepted",
        revisionIds: applied.revisionIds ?? null,
      };
    }
    const skipped = result.skipped.at(0);
    return {
      status: "skipped",
      revisionIds: null,
      skipReason: skipped?.reason ?? "unsupportedBlock",
    };
  };

  const handleAccept = async (item: ReviewSuggestion) => {
    if (item.status !== "pending") {
      return;
    }
    const unlocked = await ensureUnlocked();
    if (!unlocked) {
      return;
    }
    // Optimistic state — the card shows "Applying…" the instant the
    // user clicks. Without this the click feels dead because the
    // editor apply is synchronous and React hasn't painted between
    // state mutations. Yield a frame before the actual apply so the
    // "applying" status definitely renders even on fast machines.
    updateSuggestion(entityId, item.id, { status: "applying" });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
    const outcome = applyPending(item);
    // Keep `pendingOperation` even after a successful accept so a
    // later "Revert" can put the suggestion back into review without
    // losing the original operation spec. The lifecycle's source of
    // truth is `status`, not the presence of `pendingOperation`.
    updateSuggestion(entityId, item.id, {
      status: outcome.status,
      revisionIds: outcome.revisionIds,
      applyMode: outcome.status === "accepted" ? applyMode : null,
      ...(outcome.skipReason !== undefined && {
        skipReason: outcome.skipReason,
      }),
    });
  };

  const handleReject = (item: ReviewSuggestion) => {
    if (item.status !== "pending") {
      return;
    }
    // Same reason as accept: don't drop pendingOperation, so the
    // user can revert the rejection and the suggestion goes back
    // to actionable.
    updateSuggestion(entityId, item.id, {
      status: "rejected",
    });
  };

  const handleRevert = (item: ReviewSuggestion) => {
    if (item.status === "pending") {
      return;
    }
    // Tracked-change accepts produced revision ids we can ask
    // Folio to roll back; rolling back restores the document to
    // the pre-accept state. Direct accepts skipped the tracked-
    // changes pipeline so we have no reversible handle — the doc
    // change has been merged into history and we'd need a fresh
    // edit op to undo it. Surface that asymmetry honestly: revert
    // only flips the suggestion back to pending, the doc isn't
    // touched (the user has already-committed text they can edit
    // by hand if needed).
    if (
      item.status === "accepted" &&
      item.revisionIds !== null &&
      item.applyMode === "tracked-changes"
    ) {
      docxEditorRef.current?.rejectAIEditOperation(item.revisionIds);
    }
    updateSuggestion(entityId, item.id, {
      status: "pending",
      revisionIds: null,
      applyMode: null,
      skipReason: undefined,
    });
  };

  const handleNavigate = (item: ReviewSuggestion) => {
    setSelectedId(item.id);
    // Pending items don't have revision ids yet (nothing has been
    // applied), so scroll by the snapshot blockId instead. Once
    // accepted in tracked-changes mode the revision-ids path takes
    // over and snaps to the exact insertion/deletion marks.
    if (item.revisionIds !== null) {
      docxEditorRef.current?.scrollToAIEditOperation(item.revisionIds);
      return;
    }
    // Pass the snapshot the AI saw when it generated this op, so
    // scrollToBlock resolves blockId against stable ids instead of
    // a freshly-recomputed snapshot (which re-numbers blocks after
    // earlier structural accepts).
    docxEditorRef.current?.scrollToBlock(
      item.blockId,
      item.snapshot ?? undefined,
    );
  };

  const handleBatchAccept = async () => {
    const targets = filtered.filter((item) => item.status === "pending");
    if (targets.length === 0) {
      return;
    }
    const unlocked = await ensureUnlocked();
    if (!unlocked) {
      return;
    }
    for (const item of targets) {
      const outcome = applyPending(item);
      // Don't drop pendingOperation: handleRevert needs it to flip
      // a batch-accepted suggestion back to pending and let the
      // user accept individually again. The lifecycle's source of
      // truth is `status`, not the presence of `pendingOperation`.
      updateSuggestion(entityId, item.id, {
        status: outcome.status,
        revisionIds: outcome.revisionIds,
        applyMode: outcome.status === "accepted" ? applyMode : null,
        ...(outcome.skipReason !== undefined && {
          skipReason: outcome.skipReason,
        }),
      });
    }
  };

  const handleBatchReject = () => {
    const targets = filtered.filter((item) => item.status === "pending");
    if (targets.length === 0) {
      return;
    }
    setStatusBatch(
      entityId,
      targets.map((item) => item.id),
      "rejected",
    );
  };

  return (
    <div className="bg-background flex h-full flex-col">
      <header className="border-b px-3 py-2.5">
        {embedded ? null : (
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">
                {t("docxReview.title")}
              </h2>
              <p className="text-muted-foreground truncate text-xs">
                {t("docxReview.subtitle", {
                  pending: String(pendingCount),
                  total: String(total),
                })}
              </p>
            </div>
            <button
              aria-label={t("docxReview.dismiss")}
              className="text-muted-foreground hover:text-foreground rounded-md p-1"
              onClick={() => dismissPanel(entityId)}
              type="button"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        )}

        {/* Progress + group-by row. The progress bar gives the
         *  reviewer an at-a-glance sense of how far they've gotten;
         *  the dropdown lets them switch axis without burning two
         *  full toggle buttons in a narrow facet panel. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex max-w-full min-w-36 flex-1 items-center gap-2">
            <div
              aria-hidden="true"
              className="bg-muted h-1 min-w-12 flex-1 overflow-hidden rounded-full"
            >
              <div
                className="h-full bg-emerald-500 transition-[width] duration-300 ease-out dark:bg-emerald-400"
                style={{
                  width: total > 0 ? `${(reviewedCount / total) * 100}%` : "0%",
                }}
              />
            </div>
            <span
              aria-label={t("docxReview.progressAria", {
                reviewed: String(reviewedCount),
                total: String(total),
              })}
              className="text-foreground shrink-0 text-xs whitespace-nowrap tabular-nums"
            >
              <span className="font-semibold">
                {reviewedCount} / {total}
              </span>{" "}
              <span className="text-muted-foreground">
                {t("docxReview.reviewed")}
              </span>
            </span>
          </div>
          <div className="flex max-w-full min-w-0 items-center gap-1.5 text-xs">
            <span className="text-muted-foreground shrink-0">
              {t("docxReview.groupBy")}:
            </span>
            <Select
              onValueChange={(value) => {
                if (value === "severity" || value === "area") {
                  setGroupAxis(value);
                  setFilter(null);
                }
              }}
              value={groupAxis}
            >
              <SelectTrigger className="hover:bg-muted h-7 w-44 min-w-0 justify-between gap-1 border-0 bg-transparent px-1.5 text-xs font-medium">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="severity">
                  {t("docxReview.bySeverity")}
                </SelectItem>
                <SelectItem value="area">{t("docxReview.byArea")}</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        </div>

        {pendingCount > 0 && (
          <div className="mt-2.5">
            <div className="flex min-w-0 items-center gap-1.5 text-xs">
              <span className="text-muted-foreground shrink-0">
                {t("docxReview.applyAs")}
              </span>
              <Select
                onValueChange={(value) => {
                  if (value === "tracked-changes" || value === "direct") {
                    setApplyMode(entityId, value);
                  }
                }}
                value={applyMode}
              >
                <SelectTrigger className="hover:bg-muted h-7 w-56 min-w-0 justify-between gap-1 border-0 bg-transparent px-1.5 text-xs font-medium">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="tracked-changes">
                    {t("docxReview.applyTracked")}
                  </SelectItem>
                  <SelectItem value="direct">
                    {t("docxReview.applyDirect")}
                  </SelectItem>
                </SelectPopup>
              </Select>
              {/* Identity popover: avatar trigger shows the initials
               *  Word will use as the change author, click opens an
               *  inline editor for preferredName + wordEditShortcut
               *  (writes through to the user table) and the
               *  autohide-accepted toggle. Co-located with the apply-as
               *  selector because both control how a tracked change is
               *  recorded. */}
              {applyMode === "tracked-changes" && (
                <IdentityPopover
                  authorName={wordAuthor}
                  initialPreferredName={user.preferredName ?? ""}
                  initialWordEditShortcut={user.wordEditShortcut ?? ""}
                  initialsLabel={wordShortcut}
                  hideAccepted={hideAccepted}
                  onHideAcceptedChange={setHideAccepted}
                />
              )}
            </div>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {hideAccepted && reviewedCount > 0 && (
          // Surface for "I just hid these" — without the count and
          // a one-click way back, the toggle in the popover is
          // unfindable for anyone who didn't set it themselves.
          <button
            className="text-muted-foreground hover:bg-muted hover:text-foreground mb-2 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-[11px] transition-colors"
            onClick={() => setHideAccepted(false)}
            type="button"
          >
            <span>
              {t("docxReview.hiddenCount", { count: String(reviewedCount) })}
            </span>
            <span className="text-foreground font-medium">
              {t("docxReview.showHidden")}
            </span>
          </button>
        )}
        {groups.length === 0 ? (
          <p className="text-muted-foreground px-2 py-6 text-center text-xs">
            {t("docxReview.empty")}
          </p>
        ) : (
          groups.map((group) => (
            <section className="mb-4" key={group.key}>
              {/* Group header — colored dot anchors importance,
               *  uppercase label gives the section weight, count
               *  sits beside the label, trailing rule extends to
               *  the right so the row still reads as a section
               *  break. Tone follows the highest severity in the
               *  group when grouping by area; matches the severity
               *  directly when grouping by severity. */}
              <h3 className="text-muted-foreground mb-2 flex items-center gap-2 px-1 text-[11px] font-medium tracking-[0.06em] uppercase">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    group.tone.dot,
                  )}
                />
                <span>{group.label}</span>
                <span className="text-foreground-ghost tabular-nums">
                  {group.items.length}
                </span>
                <span
                  aria-hidden="true"
                  className="border-border/60 ms-1 h-px flex-1 border-t"
                />
              </h3>
              <ul className="space-y-1.5">
                {group.items.map((item) => (
                  <SuggestionRow
                    item={item}
                    key={item.id}
                    onAccept={() => {
                      void handleAccept(item);
                    }}
                    onNavigate={() => handleNavigate(item)}
                    onReject={() => handleReject(item)}
                    onRevert={() => handleRevert(item)}
                    selected={selectedId === item.id}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      {pendingCount > 0 && (
        <footer className="bg-background/95 supports-[backdrop-filter]:bg-background/80 shrink-0 border-t px-3 py-2 backdrop-blur">
          <div className="flex items-center gap-2">
            <Button
              className="h-8 flex-1 px-2.5 text-xs"
              onClick={() => {
                void handleBatchAccept();
              }}
              size="sm"
              variant="default"
            >
              <CheckIcon className="me-1 size-3.5" />
              {t("docxReview.acceptAll")}
            </Button>
            <Button
              className="h-8 flex-1 px-2.5 text-xs"
              onClick={handleBatchReject}
              size="sm"
              variant="outline"
            >
              <XIcon className="me-1 size-3.5" />
              {t("docxReview.rejectAll")}
            </Button>
          </div>
        </footer>
      )}
    </div>
  );
};

// -- Helpers --

type IdentityPopoverProps = {
  authorName: string;
  initialPreferredName: string;
  initialWordEditShortcut: string;
  initialsLabel: string;
  hideAccepted: boolean;
  onHideAcceptedChange: (value: boolean) => void;
};

const IdentityPopover = ({
  authorName,
  initialPreferredName,
  initialWordEditShortcut,
  initialsLabel,
  hideAccepted,
  onHideAcceptedChange,
}: IdentityPopoverProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [preferredName, setPreferredName] = useState(initialPreferredName);
  const [wordEditShortcut, setWordEditShortcut] = useState(
    initialWordEditShortcut,
  );
  // Resync local form state when the underlying user record changes
  // (e.g., another tab edited the same field) so the popover stops
  // reflecting stale values once it reopens.
  useEffect(() => {
    setPreferredName(initialPreferredName);
  }, [initialPreferredName]);
  useEffect(() => {
    setWordEditShortcut(initialWordEditShortcut);
  }, [initialWordEditShortcut]);

  const updateIdentity = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.updateUser({
        preferredName: preferredName.trim(),
        wordEditShortcut: wordEditShortcut.trim(),
      });
      if (error) {
        throw toAuthClientError(error);
      }
    },
    onSuccess: async () => {
      stellaToast.add({
        title: t("docxReview.identitySaved"),
        type: "success",
      });
      await queryClient.invalidateQueries({
        queryKey: sessionOptions.queryKey,
      });
    },
    onError: () => {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });

  return (
    <Popover>
      <PopoverTrigger
        aria-label={t("docxReview.identityAria", { name: authorName })}
        className="hover:ring-ring/40 focus-visible:ring-ring inline-flex items-center justify-center rounded-full transition-shadow hover:ring-2 focus:outline-none focus-visible:ring-2"
      >
        <Avatar className="size-6">
          <AvatarFallback className="text-[10px] font-semibold">
            {initialsLabel || "?"}
          </AvatarFallback>
        </Avatar>
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="w-72 space-y-3 p-3"
        side="bottom"
        sideOffset={6}
      >
        <div className="space-y-2">
          <label className="block">
            <span className="text-foreground mb-1 block text-xs font-medium">
              {t("docxReview.wordName")}
            </span>
            <Input
              autoComplete="off"
              className="h-8 text-xs"
              maxLength={120}
              onChange={(e) => setPreferredName(e.target.value)}
              placeholder={t("docxReview.wordNamePlaceholder")}
              value={preferredName}
            />
          </label>
          <label className="block">
            <span className="text-foreground mb-1 block text-xs font-medium">
              {t("docxReview.wordShortcut")}
            </span>
            <Input
              autoComplete="off"
              className="h-8 text-xs uppercase"
              maxLength={6}
              onChange={(e) => setWordEditShortcut(e.target.value)}
              placeholder={t("docxReview.wordShortcutPlaceholder")}
              value={wordEditShortcut}
            />
          </label>
          <Button
            className="h-7 w-full text-xs"
            disabled={
              updateIdentity.isPending ||
              (preferredName.trim() === initialPreferredName.trim() &&
                wordEditShortcut.trim() === initialWordEditShortcut.trim())
            }
            onClick={() => updateIdentity.mutate()}
            size="sm"
            variant="default"
          >
            {updateIdentity.isPending
              ? t("docxReview.savingIdentity")
              : t("docxReview.saveIdentity")}
          </Button>
        </div>
        <div className="border-border/60 border-t pt-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              checked={hideAccepted}
              onCheckedChange={onHideAcceptedChange}
            />
            <span>{t("docxReview.hideAccepted")}</span>
          </label>
        </div>
      </PopoverPopup>
    </Popover>
  );
};

type SeverityLabels = Record<ReviewSeverityKey, string>;

const useSeverityLabels = (): SeverityLabels => {
  const t = useTranslations();
  return {
    high: t("docxReview.severityHigh"),
    medium: t("docxReview.severityMedium"),
    low: t("docxReview.severityLow"),
    unspecified: t("docxReview.severityUnspecified"),
  };
};

/**
 * Redline preview for a single suggestion. Renders the AI's
 * proposed change inline as a mini-diff: the deleted text gets a
 * destructive-toned strikethrough, the inserted text gets an
 * accent-toned underline, and the surrounding block context (when
 * we have it) sits in a muted, smaller weight so the reviewer can
 * see WHERE in the block the edit lands without having to leave
 * the panel. The document is never touched — this is purely a
 * panel-side rendering.
 */
type RedlinePreviewProps = {
  preview: ReviewSuggestionPreview;
  /** Plain-text summary used as the accessible label. */
  srSummary: string;
  rejected: boolean;
  compact?: boolean | undefined;
};

const isFormattedReplaceInBlockPreview = (
  preview: ReviewSuggestionPreview,
): preview is Extract<ReviewSuggestionPreview, { type: "replaceInBlock" }> &
  Required<
    Pick<
      Extract<ReviewSuggestionPreview, { type: "replaceInBlock" }>,
      "contextStart" | "matchStart" | "matchEnd" | "contextEnd" | "sourceRuns"
    >
  > =>
  preview.type === "replaceInBlock" &&
  preview.sourceRuns !== undefined &&
  preview.contextStart !== undefined &&
  preview.matchStart !== undefined &&
  preview.matchEnd !== undefined &&
  preview.contextEnd !== undefined;

const slicePreviewRuns = (
  runs: readonly FolioAIBlockPreviewRun[],
  start: number,
  end: number,
): FolioAIBlockPreviewRun[] => {
  const sliced: FolioAIBlockPreviewRun[] = [];
  let cursor = 0;
  for (const run of runs) {
    const runStart = cursor;
    const runEnd = cursor + run.text.length;
    cursor = runEnd;
    if (runEnd <= start || runStart >= end) {
      continue;
    }

    const text = run.text.slice(
      Math.max(0, start - runStart),
      Math.min(run.text.length, end - runStart),
    );
    if (text.length === 0) {
      continue;
    }
    sliced.push({ ...run, text });
  }
  return sliced;
};

const previewRunStyle = (
  run: FolioAIBlockPreviewRun,
  compact: boolean,
): CSSProperties => {
  const style: CSSProperties = {};
  const fontFamily = cssFontFamily(run.fontFamily);
  if (fontFamily !== undefined) {
    style.fontFamily = fontFamily;
  }
  if (run.fontSizePt !== undefined) {
    const maxPt = compact ? 12.5 : 14.5;
    style.fontSize = `${Math.min(Math.max(run.fontSizePt, 8), maxPt)}pt`;
  }
  if (run.color !== undefined) {
    style.color = run.color;
  }
  if (run.bold) {
    style.fontWeight = 700;
  }
  if (run.italic) {
    style.fontStyle = "italic";
  }
  if (run.underline) {
    style.textDecorationLine = "underline";
  }
  if (run.strike) {
    if (style.textDecorationLine === "underline") {
      style.textDecorationLine = "underline line-through";
    } else {
      style.textDecorationLine = "line-through";
    }
  }
  return style;
};

const cssFontFamily = (fontFamily: string | undefined): string | undefined => {
  const first = fontFamily?.split(",").at(0)?.trim().replace(/["']/g, "");
  if (!first || !/^[\p{L}\p{N} ._-]+$/u.test(first)) {
    return undefined;
  }

  if (first.includes(" ")) {
    return `"${first}", sans-serif`;
  }

  return `${first}, sans-serif`;
};

const RedlinePreview = ({
  preview,
  srSummary,
  rejected,
  compact = false,
}: RedlinePreviewProps) => {
  const baseCls = cn(
    "text-foreground [font-family:Calibri,Arial,sans-serif] break-words",
    compact
      ? "line-clamp-1 text-[13.5px] leading-5"
      : "text-[14.5px] leading-6",
    rejected && "opacity-60",
  );
  const muted = "text-foreground-strong-muted";
  const contextCls = "text-foreground";
  const insCls =
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-1 py-0.5 rounded-sm";
  const delCls =
    "bg-destructive/10 text-destructive line-through decoration-destructive/70 px-1 py-0.5 rounded-sm";

  const arrow = (
    <ArrowRightIcon
      aria-hidden="true"
      className="text-foreground-ghost mx-1 inline size-3.5 align-middle"
    />
  );

  const renderFormattedRuns = (
    runs: readonly FolioAIBlockPreviewRun[],
    className?: string,
  ) =>
    runs.map((run, index) => (
      <span
        className={className}
        key={`${index}-${run.text}`}
        style={previewRunStyle(run, compact)}
      >
        {run.text}
      </span>
    ));

  const renderDiff = (before: string, after: string) => {
    const segments = diffWordSegments(before, after);
    // If the diff degenerates to a single delete + single insert
    // (no shared tokens at all), fall back to the arrow shape —
    // the inline diff would just show the same two halves
    // separated by nothing.
    const hasShared = segments.some((seg) => seg.type === "equal");
    if (!hasShared) {
      return (
        <>
          <span className={delCls}>{before}</span>
          {arrow}
          <span className={insCls}>{after}</span>
        </>
      );
    }
    return segments.map((seg, i) => {
      if (seg.type === "equal") {
        return <span key={i}>{seg.text}</span>;
      }
      return (
        <span className={seg.type === "del" ? delCls : insCls} key={i}>
          {seg.text}
        </span>
      );
    });
  };

  switch (preview.type) {
    case "replaceInBlock":
      if (isFormattedReplaceInBlockPreview(preview)) {
        return (
          <p aria-label={srSummary} className={baseCls}>
            {renderFormattedRuns(
              slicePreviewRuns(
                preview.sourceRuns,
                preview.contextStart,
                preview.matchStart,
              ),
              contextCls,
            )}
            {renderFormattedRuns(
              slicePreviewRuns(
                preview.sourceRuns,
                preview.matchStart,
                preview.matchEnd,
              ),
              delCls,
            )}
            {arrow}
            <span className={insCls}>{preview.after}</span>
            {renderFormattedRuns(
              slicePreviewRuns(
                preview.sourceRuns,
                preview.matchEnd,
                preview.contextEnd,
              ),
              contextCls,
            )}
          </p>
        );
      }
      return (
        <p aria-label={srSummary} className={baseCls}>
          {preview.contextBefore && (
            <span className={contextCls}>{preview.contextBefore}</span>
          )}
          {renderDiff(preview.before, preview.after)}
          {preview.contextAfter && (
            <span className={contextCls}>{preview.contextAfter}</span>
          )}
        </p>
      );
    case "replaceBlock":
      if (preview.sourceRuns !== undefined) {
        return (
          <p aria-label={srSummary} className={baseCls}>
            {renderFormattedRuns(preview.sourceRuns, delCls)}
            {arrow}
            <span className={insCls}>{preview.after}</span>
          </p>
        );
      }
      return (
        <p aria-label={srSummary} className={baseCls}>
          {renderDiff(preview.before, preview.after)}
        </p>
      );
    case "deleteBlock":
      if (preview.sourceRuns !== undefined) {
        return (
          <p aria-label={srSummary} className={baseCls}>
            {renderFormattedRuns(preview.sourceRuns, delCls)}
          </p>
        );
      }
      return (
        <p aria-label={srSummary} className={baseCls}>
          <span className={delCls}>{preview.before}</span>
        </p>
      );
    case "insertBeforeBlock":
    case "insertAfterBlock":
      return (
        <p aria-label={srSummary} className={baseCls}>
          {preview.anchorRuns !== undefined &&
            preview.anchorEnd !== undefined && (
              <>
                {renderFormattedRuns(
                  slicePreviewRuns(preview.anchorRuns, 0, preview.anchorEnd),
                  contextCls,
                )}
                {arrow}
              </>
            )}
          <span className={insCls}>{preview.after}</span>
        </p>
      );
    case "commentOnBlock":
      if (preview.anchorRuns !== undefined && preview.anchorEnd !== undefined) {
        return (
          <p aria-label={srSummary} className={cn(baseCls, muted)}>
            {renderFormattedRuns(
              slicePreviewRuns(preview.anchorRuns, 0, preview.anchorEnd),
            )}
          </p>
        );
      }
      return (
        <p aria-label={srSummary} className={cn(baseCls, muted)}>
          {preview.anchor}
        </p>
      );
    default:
      preview satisfies never;
      return null;
  }
};

type SuggestionRowProps = {
  item: ReviewSuggestion;
  onAccept: () => void;
  onNavigate: () => void;
  onReject: () => void;
  onRevert: () => void;
  selected: boolean;
};

const SuggestionRow = ({
  item,
  onAccept,
  onNavigate,
  onReject,
  onRevert,
  selected,
}: SuggestionRowProps) => {
  const t = useTranslations();
  const severityLabels = useSeverityLabels();
  const isResolved = item.status !== "pending" && item.status !== "applying";
  const isApplying = item.status === "applying";
  const tone = severityTone(item.severity);
  const showArea =
    item.area.length > 0 && item.area !== REVIEW_UNSPECIFIED_AREA;
  const isAccepted = item.status === "accepted";

  if (isResolved) {
    return (
      <li
        className={cn(
          "group bg-muted/20 hover:bg-muted/30 relative rounded-md border px-2.5 py-2 transition-colors",
          selected && "ring-ring ring-1",
          (item.status === "rejected" || item.status === "skipped") &&
            "opacity-65",
        )}
      >
        <button
          aria-label={item.summary}
          className="focus-visible:ring-ring/60 absolute inset-0 rounded-md focus:outline-none focus-visible:ring-2"
          onClick={onNavigate}
          type="button"
        />
        <div className="pointer-events-none min-w-0 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "text-muted-foreground flex shrink-0 items-center gap-1 text-[11px]",
                isAccepted && "text-foreground-muted",
              )}
            >
              {item.status === "accepted" && <CheckIcon className="size-3" />}
              {item.status === "rejected" && <XIcon className="size-3" />}
              {item.status === "accepted" && t("docxReview.statusAccepted")}
              {item.status === "rejected" && t("docxReview.statusRejected")}
              {item.status === "skipped" && t("docxReview.statusSkipped")}
            </span>
            <div className="min-w-0 flex-1 opacity-70">
              <RedlinePreview
                compact
                preview={item.preview}
                rejected={item.status === "rejected"}
                srSummary={item.summary}
              />
            </div>
          </div>
          {item.status === "skipped" && item.skipReason && (
            <p className="text-destructive text-[11px]">
              {t("docxReview.skipped", { reason: item.skipReason })}
            </p>
          )}
        </div>
        <button
          className="text-muted-foreground hover:text-foreground relative mt-1 rounded px-1 py-0.5 text-[11px] transition-colors hover:underline"
          onClick={onRevert}
          type="button"
        >
          {t("docxReview.revert")}
        </button>
      </li>
    );
  }

  return (
    <li
      className={cn(
        "group bg-card hover:bg-muted/30 relative rounded-lg border px-3 py-2.5 transition-colors",
        selected && "ring-ring ring-1",
        item.status === "rejected" && "opacity-60",
        item.status === "skipped" && "opacity-50",
      )}
    >
      {/* Full-surface hit target: an absolute-positioned button
       *  covers the entire card and routes any blank-area click to
       *  navigation. Action buttons (Accept / Reject / Revert) live
       *  in `relative`-positioned siblings below so they stack above
       *  this layer and keep their own native click handling — no
       *  stopPropagation needed, no nested-button violation. */}
      <button
        aria-label={item.summary}
        className="focus-visible:ring-ring/60 absolute inset-0 rounded-lg focus:outline-none focus-visible:ring-2"
        onClick={onNavigate}
        type="button"
      />
      <div className="pointer-events-none flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className={cn("mt-1.5 size-2 shrink-0 rounded-full", tone.dot)}
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          {/* AI's reasoning carries the most useful framing for the
           *  card title; promote it when present. The redline below
           *  is the actual diff. When there's no comment, the
           *  redline IS the title — no extra prefix. */}
          {item.comment && (
            <p className="text-foreground text-sm leading-snug font-medium">
              {item.comment}
            </p>
          )}
          <RedlinePreview
            preview={item.preview}
            rejected={item.status === "rejected"}
            srSummary={item.summary}
          />
          {/* Meta row: severity dot+label, optional document
           *  location (block displayLabel), optional area. Keeps
           *  the user oriented without competing with the redline
           *  for visual weight. */}
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
            <span
              className={cn(
                "inline-flex items-center gap-1 font-medium",
                // `tone.chip` is `border-* text-*`; the border
                // classes are inert on a borderless span and only
                // the text color renders. Reuses the constants we
                // already have rather than minting new ones.
                tone.chip,
              )}
            >
              <span
                aria-hidden="true"
                className={cn("size-1.5 rounded-full", tone.dot)}
              />
              {severityLabels[item.severity]}
            </span>
            {item.blockLabel && (
              <>
                <span aria-hidden="true">·</span>
                <span>{item.blockLabel}</span>
              </>
            )}
            {showArea && (
              <>
                <span aria-hidden="true">·</span>
                <span>{item.area}</span>
              </>
            )}
          </div>
          {item.status === "skipped" && item.skipReason && (
            <p className="text-destructive text-[11px]">
              {t("docxReview.skipped", { reason: item.skipReason })}
            </p>
          )}
        </div>
      </div>
      {!isApplying && (
        <div className="relative mt-2 flex items-center gap-1.5">
          <Button
            className="h-7 px-2.5 text-xs"
            onClick={onAccept}
            size="sm"
            variant="default"
          >
            <CheckIcon className="me-1 size-3.5" />
            {t("docxReview.accept")}
          </Button>
          <Button
            className="h-7 px-2.5 text-xs"
            onClick={onReject}
            size="sm"
            variant="outline"
          >
            <XIcon className="me-1 size-3.5" />
            {t("docxReview.reject")}
          </Button>
        </div>
      )}
      {isApplying && (
        <div
          aria-live="polite"
          className="text-muted-foreground pointer-events-none relative mt-2 flex items-center gap-1.5 text-[11px]"
        >
          <LoaderCircleIcon
            aria-hidden="true"
            className="size-3 animate-spin"
          />
          <span>{t("docxReview.statusApplying")}</span>
        </div>
      )}
      {(item.status === "accepted" ||
        item.status === "rejected" ||
        item.status === "skipped") && (
        <div className="text-muted-foreground relative mt-2 flex items-center justify-between gap-2 text-[11px]">
          <span className="flex items-center gap-1">
            {item.status === "accepted" && <CheckIcon className="size-3" />}
            {item.status === "rejected" && <XIcon className="size-3" />}
            {item.status === "accepted" && t("docxReview.statusAccepted")}
            {item.status === "rejected" && t("docxReview.statusRejected")}
            {item.status === "skipped" && t("docxReview.statusSkipped")}
          </span>
          <button
            className="hover:text-foreground rounded px-1.5 py-0.5 transition-colors hover:underline"
            onClick={onRevert}
            type="button"
          >
            {t("docxReview.revert")}
          </button>
        </div>
      )}
    </li>
  );
};
