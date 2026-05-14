/**
 * Inspector facet — workspace-scoped anonymization vocabulary.
 *
 * Lists every term the workspace has marked as PII (joined with
 * the firm's org-wide catalog, server-side). Lets the user add a
 * new term inline and delete an existing one. Terms added here
 * are immediately consulted by the chat anonymizer, the PDF
 * inspector, and any other surface that loads the workspace
 * gazetteer.
 *
 * v1 deliberately scopes down to the catalog management UX —
 * detected-on-this-file overlays, text-selection floating
 * actions, and "download anonymized" land in follow-up commits.
 */

import { useEffect, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  EyeOff,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/components/combobox";
import { Input } from "@stll/ui/components/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuPortal,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { stellaToast } from "@stll/ui/components/toast";

import { useAnonymizationActiveStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymization-active-store";
import { AnonymizationContextMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymization-context-menu";
import { useAnonymizationMatches } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymization-matches-store";
import {
  useCreateAnonymizationAllowlistEntry,
  useDeleteAnonymizationAllowlistEntry,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/anonymization-allowlist";
import {
  useCreateAnonymizationTerms,
  useDeleteAnonymizationTerm,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/anonymization-terms";
import { anonymizationAllowlistOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/anonymization-allowlist";
import { anonymizationTermsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/anonymization-terms";

/**
 * Labels users can pick from when tagging a new term. Mirrors
 * the chat anonymizer's default entity labels — without MISC
 * for v1 because adding it requires a coordinated change in
 * the upstream @stll/anonymize-wasm package.
 */
const LABEL_OPTIONS = [
  "organization",
  "person",
  "address",
  "phone number",
  "email address",
  "date",
  "date of birth",
  "bank account number",
  "iban",
  "tax identification number",
  "identity card number",
  "registration number",
  "credit card number",
  "passport number",
  "monetary amount",
  "land parcel",
] as const;

type LabelOption = (typeof LABEL_OPTIONS)[number];

const DEFAULT_LABEL: LabelOption = "organization";

type AnonymizationFacetProps = {
  workspaceId: string;
  /**
   * The currently-open document's field id. Used to look up the
   * live match snapshot the editor publishes so the facet can
   * show "N terms highlighted" and restrict the workspace list
   * to entries that actually appear in *this* document. Pass
   * `null` when the facet is mounted without an open editor
   * (peek mode, file list); the facet will then prompt the user
   * to open the full view and skip the per-doc filtering.
   */
  activeFieldId: string | null;
  /**
   * Entity id for the currently-open document. Used as the key
   * for the doc-scoped allowlist query so the override list
   * follows the file across version cuts. May be null when the
   * facet is mounted without an open document; in that case
   * doc-scoped reads are skipped and only workspace/org-wide
   * entries are visible.
   */
  entityId: string | null;
  /**
   * True when this facet's tab is the currently visible inspector
   * tab. Inactive document tabs stay mounted (just hidden), so
   * without this gate every parked Anonymization facet would
   * keep the global active counter bumped and the worker
   * heartbeat firing even after the user switched away.
   * Sidepeek leaves this defaulted (always visible).
   */
  isVisible?: boolean;
  /**
   * Invoked when the user clicks the "open full view" hint shown
   * while `activeFieldId` is null. Lets the side-peek caller wire
   * the same handler the ribbon's Full view button uses, so the
   * hint becomes the primary call-to-action instead of an
   * untriggerable label.
   */
  onOpenFullView?: () => void;
};

export const AnonymizationFacet = ({
  workspaceId,
  activeFieldId,
  entityId,
  isVisible = true,
  onOpenFullView,
}: AnonymizationFacetProps) => {
  const t = useTranslations();
  const termsQuery = useQuery(anonymizationTermsOptions(workspaceId));
  const createMutation = useCreateAnonymizationTerms();
  const deleteMutation = useDeleteAnonymizationTerm();

  const [pendingValue, setPendingValue] = useState("");
  const [pendingLabel, setPendingLabel] = useState<LabelOption>(DEFAULT_LABEL);

  // Tell the document editor to paint the in-document highlight
  // overlay while this facet is on screen; the overlay clears as
  // soon as the user switches to another inspector tab.
  //
  // Inspector tabs stay mounted (just hidden) when the user
  // switches between them, so gate on `isVisible` — without it,
  // every parked Anonymization facet kept the global active
  // counter bumped and the detection worker firing even after
  // the user moved on to a different document.
  useEffect(() => {
    if (!isVisible) {
      return undefined;
    }
    const { acquire, release } = useAnonymizationActiveStore.getState();
    acquire();
    return release;
  }, [isVisible]);

  // Selection bridge — when the user highlights text inside the
  // file preview while this facet is mounted, prefill the "Add
  // term" input. Lets the workflow be "select in document → add"
  // without a floating popover. Works for both PDF text layer
  // and Folio/DOCX since both produce a standard window
  // Selection. Folio breaks lines for the paged renderer so
  // multi-line picks are normal even for short single-name
  // selections; collapse any whitespace run (incl. newlines)
  // into a single space rather than dropping the selection.
  //
  // Only fire when the selection's BOTH endpoints sit inside the
  // file preview surface (a `.layout-page` for Folio docs, the
  // PDF text layer, or the live file viewer). Without that
  // guard, any selection in the inspector pane (term names,
  // descriptions, anywhere in the sidebar) leaks into the input.
  // Skip selections that look
  // like they live inside an input/textarea so typing into the
  // term field itself doesn't keep overwriting the value.
  useEffect(() => {
    // CSS selector for the file-preview surfaces we want to
    // accept selections from. `.layout-page` is the painted
    // Folio page; the PDF viewer uses `.textLayer`. Folio's
    // paged editor routes window.getSelection() to a hidden
    // ProseMirror at -9999px (`.paged-editor__hidden-pm`) when
    // the user drags on a painted page, so accept that surface
    // too — without it, real user selections never reach the
    // "Term to anonymize" prefill.
    const PREVIEW_SURFACES =
      ".layout-page, .textLayer, .paged-editor__hidden-pm";
    const isInsidePreview = (node: Node | null): boolean => {
      const element =
        node instanceof Element ? node : (node?.parentElement ?? null);
      return element?.closest(PREVIEW_SURFACES) !== null && element !== null;
    };
    const handler = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return;
      }
      // Both endpoints must sit inside the preview, otherwise we
      // pick up incidental selections in the inspector, sidebar,
      // tooltips, etc.
      if (
        !isInsidePreview(selection.anchorNode) ||
        !isInsidePreview(selection.focusNode)
      ) {
        return;
      }
      const raw = selection.toString();
      if (raw.length === 0) {
        return;
      }
      const single = raw.replace(/\s+/g, " ").trim();
      if (single.length < 2 || single.length > 200) {
        return;
      }
      setPendingValue(single);
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, []);

  const addTerm = (canonical: string, label: LabelOption) => {
    const trimmed = canonical.trim();
    if (trimmed.length === 0) {
      return;
    }
    createMutation.mutate(
      {
        workspaceId,
        entries: [{ canonical: trimmed, label }],
      },
      {
        onSuccess: () => {
          setPendingValue("");
          setPendingLabel(DEFAULT_LABEL);
          stellaToast.add({
            title: t("inspector.anonymization.termAddedToast", {
              value: trimmed,
            }),
            type: "success",
          });
        },
        onError: (error) => {
          stellaToast.add({
            title: error instanceof Error ? error.message : String(error),
            type: "error",
          });
        },
      },
    );
  };
  const submitTerm = () => addTerm(pendingValue, pendingLabel);

  const allEntries = termsQuery.data?.entries ?? [];
  const matchSnapshot = useAnonymizationMatches(activeFieldId);
  const allowlistQuery = useQuery({
    ...anonymizationAllowlistOptions({ workspaceId, entityId }),
    enabled: activeFieldId !== null,
  });
  const allowlistEntries = allowlistQuery.data?.entries ?? [];
  const createAllowlistMutation = useCreateAnonymizationAllowlistEntry();
  const deleteAllowlistMutation = useDeleteAnonymizationAllowlistEntry();
  // Restrict the visible workspace vocabulary to entries whose
  // canonical form is actually present in the open document. When
  // no document is open (peek mode, file list) `activeFieldId` is
  // null and the snapshot is empty — we fall back to the full
  // catalog so the user can still curate terms.
  const entries = activeFieldId
    ? allEntries.filter((entry) =>
        matchSnapshot.countByCanonical.has(entry.canonical),
      )
    : allEntries;
  const noOpenDocument = activeFieldId === null;

  // Auto-detected entities to surface in the "Detected" section.
  // Skip canonicals that already live in the workspace catalog —
  // those render above under "Matching workspace terms" so the
  // user doesn't see the same name twice. Excluded canonicals
  // disappear from the live match snapshot (they're filtered out
  // before Folio sees them), so re-merge them from the
  // exclusions store with their remembered label.
  const workspaceCanonicals = useMemo(
    () => new Set(allEntries.map((entry) => entry.canonical)),
    [allEntries],
  );
  // Index allowlist entries by canonical (case-insensitive) so the
  // UI knows which detected rows are currently overridden, plus
  // which scope they sit at (for the restore button targeting).
  type AllowlistRow = (typeof allowlistEntries)[number];
  const allowlistByCanonical = useMemo(() => {
    const map = new Map<string, AllowlistRow[]>();
    for (const entry of allowlistEntries) {
      const key = entry.canonical.toLocaleLowerCase();
      const list = map.get(key);
      if (list) {
        list.push(entry);
      } else {
        map.set(key, [entry]);
      }
    }
    return map;
  }, [allowlistEntries]);
  const detectedGroups = useMemo(() => {
    type Row = {
      canonical: string;
      count: number;
      isExcluded: boolean;
    };
    const groups = new Map<string, Row[]>();
    const seen = new Set<string>();
    const push = (
      label: string,
      canonical: string,
      count: number,
      isExcluded: boolean,
    ) => {
      const key = canonical.toLocaleLowerCase();
      if (workspaceCanonicals.has(canonical) || seen.has(key)) {
        return;
      }
      seen.add(key);
      const row = { canonical, count, isExcluded };
      const list = groups.get(label);
      if (list) {
        list.push(row);
      } else {
        groups.set(label, [row]);
      }
    };
    for (const [canonical, count] of matchSnapshot.countByCanonical) {
      const label = matchSnapshot.labelByCanonical.get(canonical) ?? "other";
      const isExcluded = allowlistByCanonical.has(
        canonical.toLocaleLowerCase(),
      );
      push(label, canonical, count, isExcluded);
    }
    // Allowlist entries that no longer show up in the live match
    // snapshot (pipeline already dropped them) still need a row so
    // the user can restore them.
    for (const entry of allowlistEntries) {
      push(entry.label, entry.canonical, 0, true);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.canonical.localeCompare(b.canonical));
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [
    matchSnapshot.countByCanonical,
    matchSnapshot.labelByCanonical,
    allowlistByCanonical,
    allowlistEntries,
    workspaceCanonicals,
  ]);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleGroup = (label: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <h3 className="text-foreground text-sm font-medium">
        {t("inspector.anonymization.title")}
      </h3>

      <form
        className="flex flex-col gap-2 rounded-md border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          submitTerm();
        }}
      >
        <Input
          autoComplete="off"
          disabled={createMutation.isPending}
          onChange={(event) => setPendingValue(event.target.value)}
          placeholder={t("inspector.anonymization.addPlaceholder")}
          value={pendingValue}
        />
        <div className="flex items-center gap-2">
          <Combobox<LabelOption>
            autoHighlight
            disabled={createMutation.isPending}
            items={[...LABEL_OPTIONS]}
            itemToStringLabel={(option) => option}
            onValueChange={(next) => {
              if (next) {
                setPendingLabel(next);
              }
            }}
            value={pendingLabel}
          >
            <ComboboxInput
              aria-label={t("inspector.anonymization.labelPickerAriaLabel")}
              className="h-9 min-w-0 flex-1 text-xs"
              placeholder={t("inspector.anonymization.labelPickerPlaceholder")}
            />
            <ComboboxPopup>
              <ComboboxList>
                {(option: LabelOption) => (
                  <ComboboxItem key={option} value={option}>
                    {option}
                  </ComboboxItem>
                )}
              </ComboboxList>
              <ComboboxEmpty>
                {t("inspector.anonymization.labelPickerEmpty")}
              </ComboboxEmpty>
            </ComboboxPopup>
          </Combobox>
          <Button
            disabled={
              pendingValue.trim().length === 0 || createMutation.isPending
            }
            size="sm"
            type="submit"
          >
            {t("inspector.anonymization.addAction")}
          </Button>
        </div>
      </form>

      {noOpenDocument ? (
        onOpenFullView ? (
          <Button
            className="border-muted-foreground/30 bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground h-auto w-full justify-start rounded-md border border-dashed px-3 py-2 text-start text-xs whitespace-normal sm:h-auto"
            onClick={onOpenFullView}
            type="button"
            variant="ghost"
          >
            {t("inspector.anonymization.openFullViewHint")}
          </Button>
        ) : (
          <div className="border-muted-foreground/30 bg-muted/40 text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs">
            {t("inspector.anonymization.openFullViewHint")}
          </div>
        )
      ) : (
        <div className="bg-muted/40 text-foreground rounded-md px-3 py-2 text-xs">
          {t("inspector.anonymization.matchCount", {
            count: String(matchSnapshot.totalMatches),
          })}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {noOpenDocument
            ? t("inspector.anonymization.workspaceTermsHeading", {
                count: String(entries.length),
              })
            : t("inspector.anonymization.matchedWorkspaceTermsHeading", {
                count: String(entries.length),
              })}
        </div>
        {termsQuery.isLoading && (
          <div className="text-muted-foreground py-6 text-center text-xs">
            {t("common.loading")}
          </div>
        )}
        {!termsQuery.isLoading && entries.length === 0 && (
          <div className="text-muted-foreground rounded-md border border-dashed py-6 text-center text-xs">
            {noOpenDocument || allEntries.length === 0
              ? t("inspector.anonymization.emptyState")
              : t("inspector.anonymization.noMatchesInDocument")}
          </div>
        )}
        {entries.map((entry) => {
          const hitCount = matchSnapshot.countByCanonical.get(entry.canonical);
          return (
            <div
              className="hover:bg-muted/50 flex items-center justify-between gap-2 rounded-md border px-3 py-2"
              key={entry.id}
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">
                  {entry.canonical}
                </span>
                <span className="text-muted-foreground text-xs">
                  {entry.label}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {hitCount !== undefined && hitCount > 0 && (
                  <span
                    className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs tabular-nums"
                    aria-label={t(
                      "inspector.anonymization.termMatchCountAriaLabel",
                      { count: String(hitCount) },
                    )}
                    title={t(
                      "inspector.anonymization.termMatchCountAriaLabel",
                      { count: String(hitCount) },
                    )}
                  >
                    {hitCount}
                  </span>
                )}
                <Button
                  disabled={deleteMutation.isPending}
                  onClick={() =>
                    deleteMutation.mutate({ workspaceId, entryId: entry.id })
                  }
                  size="icon"
                  variant="ghost"
                >
                  <Trash2 className="size-4" />
                  <span className="sr-only">
                    {t("inspector.anonymization.deleteAction")}
                  </span>
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      {!noOpenDocument && detectedGroups.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {t("inspector.anonymization.detectedHeading", {
              count: String(
                detectedGroups.reduce((sum, [, rows]) => sum + rows.length, 0),
              ),
            })}
          </div>
          {detectedGroups.map(([label, rows]) => {
            const isOpen = expandedGroups.has(label);
            const activeCount = rows.filter((r) => !r.isExcluded).length;
            return (
              <div className="rounded-md border" key={label}>
                <button
                  aria-expanded={isOpen}
                  className="hover:bg-muted/50 flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-start"
                  onClick={() => toggleGroup(label)}
                  type="button"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {isOpen ? (
                      <ChevronDown className="text-muted-foreground size-4 shrink-0" />
                    ) : (
                      <ChevronRight className="text-muted-foreground size-4 shrink-0" />
                    )}
                    <span className="truncate text-sm font-medium">
                      {label}
                    </span>
                  </span>
                  <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs tabular-nums">
                    {activeCount}
                  </span>
                </button>
                {isOpen && (
                  <ul className="flex flex-col gap-px border-t">
                    {rows.map((row) => (
                      <li
                        className={
                          row.isExcluded
                            ? "text-muted-foreground hover:bg-muted/30 flex items-center justify-between gap-2 px-3 py-1.5 line-through"
                            : "hover:bg-muted/50 flex items-center justify-between gap-2 px-3 py-1.5"
                        }
                        key={row.canonical}
                      >
                        <span className="truncate text-xs">
                          {row.canonical}
                        </span>
                        <span className="flex items-center gap-1">
                          {!row.isExcluded && row.count > 0 && (
                            <span
                              aria-label={t(
                                "inspector.anonymization.termMatchCountAriaLabel",
                                { count: String(row.count) },
                              )}
                              className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs tabular-nums"
                              title={t(
                                "inspector.anonymization.termMatchCountAriaLabel",
                                { count: String(row.count) },
                              )}
                            >
                              {row.count}
                            </span>
                          )}
                          {row.isExcluded ? (
                            <Button
                              aria-label={t(
                                "inspector.anonymization.restoreAction",
                              )}
                              disabled={deleteAllowlistMutation.isPending}
                              onClick={() => {
                                const matches = allowlistByCanonical.get(
                                  row.canonical.toLocaleLowerCase(),
                                );
                                if (!matches) {
                                  return;
                                }
                                for (const entry of matches) {
                                  deleteAllowlistMutation.mutate({
                                    workspaceId,
                                    entryId: entry.id,
                                  });
                                }
                              }}
                              size="icon"
                              title={t("inspector.anonymization.restoreAction")}
                              variant="ghost"
                            >
                              <RotateCcw className="size-3.5" />
                            </Button>
                          ) : (
                            <>
                              <Button
                                aria-label={t(
                                  "inspector.anonymization.ignoreAction",
                                )}
                                disabled={createAllowlistMutation.isPending}
                                onClick={() => {
                                  createAllowlistMutation.mutate({
                                    workspaceId,
                                    entityId,
                                    canonical: row.canonical,
                                    label,
                                    scope: "document",
                                  });
                                }}
                                size="icon"
                                title={t(
                                  "inspector.anonymization.ignoreAction",
                                )}
                                variant="ghost"
                              >
                                <EyeOff className="size-3.5" />
                              </Button>
                              <Menu>
                                <MenuTrigger
                                  render={
                                    <Button
                                      aria-label={t(
                                        "inspector.anonymization.ignoreScopeMenuAriaLabel",
                                      )}
                                      size="icon"
                                      variant="ghost"
                                    >
                                      <ChevronDown className="size-3.5" />
                                    </Button>
                                  }
                                />
                                <MenuPortal>
                                  <MenuPopup>
                                    <MenuItem
                                      onClick={() => {
                                        createAllowlistMutation.mutate({
                                          workspaceId,
                                          entityId,
                                          canonical: row.canonical,
                                          label,
                                          scope: "workspace",
                                        });
                                      }}
                                    >
                                      {t(
                                        "inspector.anonymization.ignoreScopeWorkspace",
                                      )}
                                    </MenuItem>
                                  </MenuPopup>
                                </MenuPortal>
                              </Menu>
                            </>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
      <AnonymizationContextMenu
        onAnonymize={(selection) => addTerm(selection, pendingLabel)}
      />
    </div>
  );
};
