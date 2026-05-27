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

import { useEffect, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  ExternalLinkIcon,
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

import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { useAnonymizationActiveStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymization-active-store";
import { AnonymizationContextMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymization-context-menu";
import {
  useAnonymizationMatches,
  useAnonymizationMatchesReady,
} from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymization-matches-store";
import { useAnonymizationSelectionStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymization-selection-store";
import { useDocumentTextSelection } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/document-text-selection-store";
import {
  anonymizationAllowlistKeys,
  anonymizationAllowlistOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/anonymization-allowlist";
import {
  anonymizationTermsKeys,
  anonymizationTermsOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/anonymization-terms";

// Org-wide ignore lands behind a dedicated org-settings handler
// with `organizationSettings` permissions; until that ships, the
// workspace endpoint accepts doc and workspace scopes only so a
// workspace editor cannot mask data firm-wide.
type AllowlistScope = "document" | "workspace";

/**
 * Labels users can pick from when tagging a new term. Mirrors
 * the chat anonymizer's default entity labels (`misc` is now
 * supported end-to-end in `@stll/anonymize-wasm`).
 */
const LABEL_OPTIONS = [
  "misc",
  "organization",
  "person",
  "address",
  "country",
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

// Misc is the safest default — most user-added terms don't
// fit the structured categories cleanly, and it forces the
// person to consciously upgrade the label when one of the
// PII-specific buckets really does apply.
const DEFAULT_LABEL: LabelOption = "misc";

// Map the anonymizer's English label strings (the pipeline
// emits canonicals like "organization", "phone number") onto
// the existing `common.anonymizationLabels.*` translation keys.
// Detector output not in this map falls back to the raw label
// string so unfamiliar categories still render something
// readable.
const LABEL_TRANSLATION_KEYS = {
  organization: "common.anonymizationLabels.organization",
  person: "common.anonymizationLabels.person",
  address: "common.anonymizationLabels.address",
  country: "common.country",
  "phone number": "common.anonymizationLabels.phoneNumber",
  "email address": "common.anonymizationLabels.emailAddress",
  date: "common.anonymizationLabels.date",
  "date of birth": "common.anonymizationLabels.dateOfBirth",
  "bank account number": "common.anonymizationLabels.bankAccountNumber",
  iban: "common.anonymizationLabels.iban",
  "tax identification number":
    "common.anonymizationLabels.taxIdentificationNumber",
  "identity card number": "common.anonymizationLabels.identityCardNumber",
  "registration number": "common.anonymizationLabels.registrationNumber",
  "credit card number": "common.anonymizationLabels.creditCardNumber",
  "passport number": "common.anonymizationLabels.passportNumber",
  "monetary amount": "common.anonymizationLabels.monetaryAmount",
  "land parcel": "common.anonymizationLabels.landParcel",
  misc: "common.anonymizationLabels.miscellaneous",
  // Back-compat alias: legacy server entries still labelled
  // "other" before the wasm runtime adopted the canonical
  // "misc" key. Kept so old workspace catalogs render with a
  // proper translated label instead of falling back to the
  // raw string.
  other: "common.anonymizationLabels.miscellaneous",
} as const satisfies Record<string, TranslationKey>;

type LabelTranslationKey = keyof typeof LABEL_TRANSLATION_KEYS;

const isLabelTranslationKey = (label: string): label is LabelTranslationKey =>
  label in LABEL_TRANSLATION_KEYS;

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
  const analytics = useAnalytics();
  const formatLabel = (label: string): string =>
    isLabelTranslationKey(label) ? t(LABEL_TRANSLATION_KEYS[label]) : label;
  const termsQuery = useQuery(anonymizationTermsOptions(workspaceId));
  const createMutation = useMutation({
    mutationFn: async (vars: {
      workspaceId: string;
      entries: readonly {
        canonical: string;
        label: string;
        variants?: readonly string[];
      }[];
    }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(vars.workspaceId) })
        ["anonymization-terms"].put({
          entries: vars.entries.map((entry) =>
            entry.variants
              ? {
                  canonical: entry.canonical,
                  label: entry.label,
                  variants: [...entry.variants],
                }
              : {
                  canonical: entry.canonical,
                  label: entry.label,
                },
          ),
          queryKey: anonymizationTermsKeys.all(vars.workspaceId),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: async (vars: { workspaceId: string; entryId: string }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(vars.workspaceId) })
        ["anonymization-terms"]({
          entryId: toSafeId<"anonymizationBlacklistEntry">(vars.entryId),
        })
        .delete({
          queryKey: anonymizationTermsKeys.all(vars.workspaceId),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

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
    // PDF viewer renders a real DOM `.textLayer` whose
    // selections show up in `window.getSelection()`. The folio
    // paged editor doesn't — it sets PM selections
    // programmatically on an off-screen hidden PM and renders
    // visible selection via a custom overlay. Folio
    // selections come in via the document-text-selection
    // store (subscribed below); the listener here only
    // handles the PDF case.
    const PREVIEW_SURFACES = ".textLayer";
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
      const single = raw.replace(/\s+/gu, " ").trim();
      if (single.length < 2 || single.length > 200) {
        return;
      }
      setPendingValue(single);
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, []);

  // Folio selection bridge — picks up PM selections that
  // live in the off-screen hidden PM and aren't visible to
  // `window.getSelection()`. The docx editor wrapper
  // wraps `view.dispatch` and publishes the latest
  // selected text here on every selection-bearing
  // transaction.
  const folioSelection = useDocumentTextSelection(activeFieldId);
  useEffect(() => {
    if (folioSelection === null) {
      return;
    }
    setPendingValue(folioSelection.text);
    // `seq` is part of the dep array so re-selecting the
    // same string still re-fires the prefill.
  }, [folioSelection]);

  const addTerm = async (canonical: string, label: LabelOption) => {
    const trimmed = canonical.trim();
    if (trimmed.length === 0) {
      return;
    }
    try {
      await createMutation.mutateAsync({
        workspaceId,
        entries: [{ canonical: trimmed, label }],
      });
      setPendingValue("");
      setPendingLabel(DEFAULT_LABEL);
      stellaToast.add({
        title: t("inspector.anonymization.termAddedToast", {
          value: trimmed,
        }),
        type: "success",
      });
    } catch (error) {
      stellaToast.add({
        title: error instanceof Error ? error.message : String(error),
        type: "error",
      });
    }
  };
  const submitTerm = async () => {
    await addTerm(pendingValue, pendingLabel);
  };

  const allEntries = termsQuery.data?.entries;
  const matchSnapshot = useAnonymizationMatches(activeFieldId);
  const matchesReady = useAnonymizationMatchesReady(activeFieldId);
  const allowlistQuery = useQuery({
    ...anonymizationAllowlistOptions({ workspaceId, entityId }),
    enabled: activeFieldId !== null,
  });
  const allowlistEntries = allowlistQuery.data?.entries;
  const createAllowlistMutation = useMutation({
    mutationFn: async (vars: {
      workspaceId: string;
      entityId: string | null;
      canonical: string;
      label: string;
      scope: AllowlistScope;
    }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(vars.workspaceId) })
        ["anonymization-allowlist"].put({
          canonical: vars.canonical,
          label: vars.label,
          scope: vars.scope,
          ...(vars.scope === "document" && vars.entityId
            ? { entityId: toSafeId<"entity">(vars.entityId) }
            : {}),
          // Workspace-scoped writes affect every doc in the
          // workspace, so invalidate by the workspace-only key
          // prefix; that wakes up every open document's
          // entity-keyed allowlist query. Doc-scoped writes only
          // need to refresh their own query.
          queryKey:
            vars.scope === "workspace"
              ? anonymizationAllowlistKeys.workspace(vars.workspaceId)
              : anonymizationAllowlistKeys.all({
                  workspaceId: vars.workspaceId,
                  entityId: vars.entityId,
                }),
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
  const deleteAllowlistMutation = useMutation({
    mutationFn: async (vars: { workspaceId: string; entryId: string }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(vars.workspaceId) })
        ["anonymization-allowlist"]({
          entryId: toSafeId<"anonymizationAllowlistEntry">(vars.entryId),
        })
        .delete({
          // The caller doesn't know whether the deleted row was
          // doc- or workspace-scoped, so broadcast on the
          // workspace-prefix key. That refreshes every open
          // document's allowlist query in this workspace.
          queryKey: anonymizationAllowlistKeys.workspace(vars.workspaceId),
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
  // Restrict the visible workspace vocabulary to entries whose
  // canonical form is actually present in the open document. When
  // no document is open (peek mode, file list) `activeFieldId` is
  // null and the snapshot is empty — we fall back to the full
  // catalog so the user can still curate terms. Same fallback
  // while `!matchesReady`: detection hasn't published yet, so
  // filtering would collapse the list to "0 matches" and look
  // identical to "actually nothing matches".
  const entries = useMemo(() => {
    const sourceEntries = allEntries ?? [];
    if (activeFieldId && matchesReady) {
      return sourceEntries.filter((entry) =>
        matchSnapshot.countByCanonical.has(entry.canonical),
      );
    }
    return sourceEntries;
  }, [activeFieldId, allEntries, matchesReady, matchSnapshot.countByCanonical]);
  const noOpenDocument = activeFieldId === null;

  // Auto-detected entities to surface in the "Detected" section.
  // Skip canonicals that already live in the workspace catalog —
  // those render above under "Matching workspace terms" so the
  // user doesn't see the same name twice. Excluded canonicals
  // disappear from the live match snapshot (they're filtered out
  // before Folio sees them), so re-merge them from the
  // exclusions store with their remembered label.
  const workspaceCanonicals = useMemo(
    () => new Set((allEntries ?? []).map((entry) => entry.canonical)),
    [allEntries],
  );
  // Index allowlist entries by canonical (case-insensitive) so the
  // UI knows which detected rows are currently overridden, plus
  // which scope they sit at (for the restore button targeting).
  type AllowlistRow = NonNullable<typeof allowlistEntries>[number];
  const allowlistByCanonical = useMemo(() => {
    const map = new Map<string, AllowlistRow[]>();
    for (const entry of allowlistEntries ?? []) {
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
    for (const entry of allowlistEntries ?? []) {
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

  // Click in the document → highlight matching row here.
  // Subscribe to the bridge store and, on every doc-sourced
  // selection bump *for this document*, find the row by data
  // attribute, scroll it into view, and run a brief outline
  // flash. Sidebar-sourced selections (our own emits) are
  // ignored to avoid loops; selections from other docs (cached
  // tab panes) are ignored too.
  const containerRef = useRef<HTMLDivElement>(null);
  // Select primitives separately rather than returning a fresh
  // `{ canonical, label, seq }` object from the selector. Zustand
  // v5 uses referential equality on selector results, so an
  // object literal would re-render on every store change and risk
  // an infinite getSnapshot loop. Each primitive selector is
  // stable across unrelated updates.
  const docSelectionCanonical = useAnonymizationSelectionStore((s) =>
    s.source === "doc" && s.fieldId === activeFieldId ? s.canonical : null,
  );
  const docSelectionLabel = useAnonymizationSelectionStore((s) =>
    s.source === "doc" && s.fieldId === activeFieldId ? s.label : null,
  );
  const docSelectionSeq = useAnonymizationSelectionStore((s) =>
    s.source === "doc" && s.fieldId === activeFieldId ? s.seq : 0,
  );
  useEffect(() => {
    if (!docSelectionCanonical) {
      return;
    }
    // Detected groups start collapsed; if the doc click lands on
    // a detected canonical whose group isn't open yet, expand it
    // first. The effect re-runs after expandedGroups updates and
    // proceeds to the scroll/flash branch below.
    if (
      docSelectionLabel &&
      !expandedGroups.has(docSelectionLabel) &&
      // Only the detected section is collapsible — workspace
      // term rows live above it and are always visible.
      detectedGroups.some(([label]) => label === docSelectionLabel)
    ) {
      setExpandedGroups((prev) => {
        const next = new Set(prev);
        next.add(docSelectionLabel);
        return next;
      });
      return;
    }
    const root = containerRef.current;
    if (!root) {
      return;
    }
    // `seq` is part of the dep array so repeated clicks of the
    // same canonical re-fire the scroll + flash.
    const selector = `[data-anonymization-canonical="${CSS.escape(docSelectionCanonical)}"]`;
    const row = root.querySelector<HTMLElement>(selector);
    if (!row) {
      return;
    }
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    row.animate(
      [
        { boxShadow: "inset 0 0 0 2px var(--primary)" },
        { boxShadow: "inset 0 0 0 2px transparent" },
      ],
      { duration: 600, easing: "ease-out" },
    );
  }, [
    docSelectionCanonical,
    docSelectionLabel,
    docSelectionSeq,
    expandedGroups,
    detectedGroups,
  ]);

  const selectFromSidebar = (canonical: string, label: string) => {
    if (activeFieldId === null) {
      return;
    }
    useAnonymizationSelectionStore
      .getState()
      .select(canonical, label, "sidebar", activeFieldId);
  };

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
    >
      <h3 className="text-foreground text-sm font-medium">
        {t("inspector.anonymization.title")}
      </h3>

      <form
        action={submitTerm}
        className="flex flex-col gap-2 rounded-md border p-3"
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
            itemToStringLabel={formatLabel}
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
                    {formatLabel(option)}
                  </ComboboxItem>
                )}
              </ComboboxList>
              <ComboboxEmpty>
                {t("inspector.anonymization.labelPickerEmpty")}
              </ComboboxEmpty>
            </ComboboxPopup>
          </Combobox>
          <AddTermSubmitButton
            disabled={pendingValue.trim().length === 0}
            label={t("inspector.anonymization.addAction")}
          />
        </div>
      </form>

      {(() => {
        if (noOpenDocument) {
          return (() => {
            if (onOpenFullView) {
              return (
                <Button
                  className="text-muted-foreground hover:bg-muted/50 hover:text-foreground h-auto w-full justify-start gap-2.5 rounded-md px-3 py-2.5 text-start text-sm leading-relaxed whitespace-normal"
                  onClick={onOpenFullView}
                  type="button"
                  variant="ghost"
                >
                  <ExternalLinkIcon className="size-4 shrink-0" />
                  <span>{t("inspector.anonymization.openFullViewHint")}</span>
                </Button>
              );
            }
            return (
              <div className="text-muted-foreground flex items-start gap-2.5 rounded-md px-3 py-2.5 text-sm leading-relaxed">
                <ExternalLinkIcon className="mt-0.5 size-4 shrink-0" />
                <span>{t("inspector.anonymization.openFullViewHint")}</span>
              </div>
            );
          })();
        }
        if (!matchesReady) {
          return (
            <div className="text-muted-foreground bg-muted/40 rounded-md px-3 py-2 text-xs">
              {t("inspector.anonymization.detectingMatches")}
            </div>
          );
        }
        return (
          <div className="bg-muted/40 text-foreground rounded-md px-3 py-2 text-xs">
            {t("inspector.anonymization.matchCount", {
              count: String(matchSnapshot.totalMatches),
            })}
          </div>
        );
      })()}

      <div className="flex flex-col gap-1">
        <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {noOpenDocument || !matchesReady
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
            {noOpenDocument || (allEntries?.length ?? 0) === 0
              ? t("inspector.anonymization.emptyState")
              : t("inspector.anonymization.noMatchesInDocument")}
          </div>
        )}
        {entries.map((entry) => {
          const hitCount = matchSnapshot.countByCanonical.get(entry.canonical);
          return (
            <div
              className="hover:bg-muted/50 flex items-center justify-between gap-2 rounded-md border px-3 py-2"
              data-anonymization-canonical={entry.canonical}
              key={entry.id}
            >
              <button
                className="flex min-w-0 flex-1 flex-col text-start"
                onClick={() => selectFromSidebar(entry.canonical, entry.label)}
                type="button"
              >
                <span className="truncate text-sm font-medium">
                  {entry.canonical}
                </span>
                <span className="text-muted-foreground text-xs">
                  {formatLabel(entry.label)}
                </span>
              </button>
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
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteMutation.mutate({ workspaceId, entryId: entry.id });
                  }}
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
      {!noOpenDocument && matchesReady && detectedGroups.length > 0 && (
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
                      {formatLabel(label)}
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
                        data-anonymization-canonical={row.canonical}
                        key={row.canonical}
                      >
                        <button
                          className="min-w-0 flex-1 truncate text-start text-xs"
                          onClick={() =>
                            selectFromSidebar(row.canonical, label)
                          }
                          type="button"
                        >
                          {row.canonical}
                        </button>
                        <div className="flex items-center gap-1">
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
                                          scope: "document",
                                        });
                                      }}
                                    >
                                      {t(
                                        "inspector.anonymization.ignoreScopeDocument",
                                      )}
                                    </MenuItem>
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
                                        "inspector.anonymization.ignoreScopeAlways",
                                      )}
                                    </MenuItem>
                                  </MenuPopup>
                                </MenuPortal>
                              </Menu>
                            </>
                          )}
                        </div>
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
        onAnonymize={(selection) => {
          void addTerm(selection, pendingLabel);
        }}
      />
    </div>
  );
};

const AddTermSubmitButton = ({
  disabled,
  label,
}: {
  disabled: boolean;
  label: string;
}) => {
  const { pending } = useFormStatus();
  return (
    <Button disabled={disabled || pending} size="sm" type="submit">
      {label}
    </Button>
  );
};
