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

import { useEffect, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";

import {
  useCreateAnonymizationTerms,
  useDeleteAnonymizationTerm,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/anonymization-terms";
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
};

export const AnonymizationFacet = ({
  workspaceId,
}: AnonymizationFacetProps) => {
  const t = useTranslations();
  const termsQuery = useQuery(anonymizationTermsOptions(workspaceId));
  const createMutation = useCreateAnonymizationTerms();
  const deleteMutation = useDeleteAnonymizationTerm();

  const [pendingValue, setPendingValue] = useState("");
  const [pendingLabel, setPendingLabel] = useState<LabelOption>(DEFAULT_LABEL);

  // Selection bridge — when the user highlights text anywhere in
  // the file preview while this facet is mounted, prefill the
  // "Add term" input. Lets the workflow be "select in document →
  // add" without a floating popover. Works for PDF text layer
  // and Folio/DOCX since both produce a standard window Selection.
  // Only fires for short, single-line selections to keep accidental
  // multi-paragraph picks out of the input.
  useEffect(() => {
    const handler = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
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
      if (single.includes("\n")) {
        return;
      }
      setPendingValue(single);
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, []);

  const submitTerm = () => {
    const canonical = pendingValue.trim();
    if (canonical.length === 0) {
      return;
    }
    createMutation.mutate(
      {
        workspaceId,
        entries: [{ canonical, label: pendingLabel }],
      },
      {
        onSuccess: () => {
          setPendingValue("");
          setPendingLabel(DEFAULT_LABEL);
          stellaToast.add({
            title: t("inspector.anonymization.termAddedToast", {
              value: canonical,
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

  const entries = termsQuery.data?.entries ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex flex-col gap-2">
        <h3 className="text-foreground text-sm font-medium">
          {t("inspector.anonymization.title")}
        </h3>
        <p className="text-muted-foreground text-xs">
          {t("inspector.anonymization.description")}
        </p>
      </div>

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
          <select
            className="border-input bg-background h-9 flex-1 rounded-md border px-2 text-xs"
            disabled={createMutation.isPending}
            onChange={(event) => {
              const next = LABEL_OPTIONS.find(
                (option) => option === event.target.value,
              );
              if (next) {
                setPendingLabel(next);
              }
            }}
            value={pendingLabel}
          >
            {LABEL_OPTIONS.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
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

      <div className="flex flex-col gap-1">
        <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {t("inspector.anonymization.workspaceTermsHeading", {
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
            {t("inspector.anonymization.emptyState")}
          </div>
        )}
        {entries.map((entry) => (
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
        ))}
      </div>
    </div>
  );
};
