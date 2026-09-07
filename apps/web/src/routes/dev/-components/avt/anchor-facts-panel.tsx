/**
 * AVT — anchor-fact extraction & review (subtask 1: the anchor-facts
 * store). Editable table of curated evidence; genuinely-uncertain
 * extractions are flagged and held out of scoring until a reviewer
 * confirms, edits, or retypes them. Confidence here is INTERPRETIVE
 * (meaning certainty), never derived from the source medium.
 *
 * Ported from the prototype's `app/anchors.jsx` onto real @stll/ui
 * primitives (Table, Select, Textarea, Frame) in place of bespoke CSS.
 */

import * as React from "react";

import {
  PencilIcon,
  PlusIcon,
  ShieldAlertIcon,
  UploadIcon,
} from "lucide-react";

import { Button } from "@stll/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/components/table";
import { Textarea } from "@stll/ui/components/textarea";
import { cn } from "@stll/ui/lib/utils";

import { useFormatter } from "@/i18n/formatting-context";
import { useAvtStore } from "@/routes/dev/-components/avt/avt-store";
import {
  InterpNote,
  MediumChip,
} from "@/routes/dev/-components/avt/state-chip";
import {
  CONFIDENCE_LEVELS,
  type AnchorFact,
} from "@/routes/dev/-components/avt/types";

function orderFlaggedFirst(facts: readonly AnchorFact[]): AnchorFact[] {
  return [...facts].sort(
    (a, b) => Number(Boolean(b.flag)) - Number(Boolean(a.flag)),
  );
}

export function AnchorFactsPanel() {
  const format = useFormatter();
  const facts = useAvtStore((state) => state.facts);
  const setFactConfidence = useAvtStore((state) => state.setFactConfidence);
  const acceptFact = useAvtStore((state) => state.acceptFact);
  const editFact = useAvtStore((state) => state.editFact);

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");

  const ordered = orderFlaggedFirst(Object.values(facts));
  const heldCount = ordered.filter(
    (fact) => fact.flag && !fact.accepted,
  ).length;

  const startEdit = (fact: AnchorFact) => {
    if (editingId !== null) {
      return;
    }
    setEditingId(fact.id);
    setDraft(fact.fact);
  };

  /**
   * An empty draft is never saved. `editFact` also marks the fact
   * confirmed and clears its held-for-review flag, so saving a cleared
   * textarea would erase the evidence text *and* quietly promote the
   * fact out of the review queue — the worst combination for a record
   * that later has to be relied on. The Save button is disabled in that
   * state; this guard is the backstop.
   */
  const saveEdit = (factId: string) => {
    const text = draft.trim();
    if (text === "") {
      return;
    }
    editFact(factId, text);
    setEditingId(null);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            Anchor facts
          </div>
          <h2 className="text-lg font-semibold">Extraction &amp; review</h2>
          <p className="text-muted-foreground mt-1.5 max-w-prose text-sm leading-relaxed">
            Hard evidence — emails, messages, bank records, agreed facts —
            extracted into the anchor-fact record that claims are checked
            against. Review, edit, or add facts by hand.
          </p>
        </div>
        {/*
          Both actions need ingestion and persistence that this harness
          does not have, so they are disabled rather than left as buttons
          that silently do nothing: a primary control labelled "Add fact"
          that swallows a click reads as broken, not as unfinished.
          Disabling also takes them out of the tab order, so a keyboard
          user is not sent to a dead end.
        */}
        <div className="flex shrink-0 gap-2">
          <Button
            disabled
            size="sm"
            title="Not available in this harness — importing a source needs ingestion and storage that are not wired up yet."
            variant="outline"
          >
            <UploadIcon /> Import source
          </Button>
          <Button
            disabled
            size="sm"
            title="Not available in this harness — adding a fact needs persistence that is not wired up yet."
          >
            <PlusIcon /> Add fact
          </Button>
        </div>
      </div>

      {heldCount > 0 && (
        <div className="text-warning-foreground bg-warning/10 border-warning/32 rounded-lg border p-3.5">
          <div className="text-warning flex items-center gap-2 text-sm font-bold">
            <ShieldAlertIcon aria-hidden="true" className="size-4" />
            Held for review
            <span className="bg-warning text-warning-foreground rounded-full px-2 py-0.5 text-xs">
              {format.number(heldCount)}
            </span>
          </div>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            These extractions are <b>genuinely uncertain in meaning</b> — the
            content is provisional or unconfirmed, not merely written by hand.
            They are held out of scoring until a reviewer confirms, edits, or
            retypes them. A legible source is never queued just for its medium.
          </p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Anchor-fact record</h3>
        <span className="text-muted-foreground text-sm">
          {format.number(ordered.length)} facts
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[34%] whitespace-normal">Fact</TableHead>
              <TableHead className="w-[26%] whitespace-normal">
                Source &amp; provenance
              </TableHead>
              <TableHead>Interpretation</TableHead>
              <TableHead>Time period</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordered.map((fact) => (
              <TableRow
                className={cn("align-top", fact.flag && "bg-warning/6")}
                key={fact.id}
              >
                <TableCell className="max-w-0 min-w-0 py-3 wrap-break-word whitespace-normal">
                  {editingId === fact.id ? (
                    <div className="space-y-2">
                      <Textarea
                        aria-label="Anchor fact text"
                        onChange={(event) => setDraft(event.target.value)}
                        value={draft}
                      />
                      <div className="flex gap-1.5">
                        <Button
                          disabled={draft.trim() === ""}
                          onClick={() => saveEdit(fact.id)}
                          size="sm"
                        >
                          Save
                        </Button>
                        <Button
                          onClick={() => setEditingId(null)}
                          size="sm"
                          variant="ghost"
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2 text-sm leading-relaxed">
                      <p>{fact.fact}</p>
                      {fact.medium && <MediumChip medium={fact.medium} />}
                      <InterpNote note={fact.interpNote} />
                      {fact.flag && (
                        <div className="flex gap-1.5">
                          <Button
                            className="text-success border-success/32 bg-success/10"
                            onClick={() => acceptFact(fact.id)}
                            size="sm"
                            variant="outline"
                          >
                            Confirm
                          </Button>
                          <Button
                            disabled={editingId !== null}
                            onClick={() => startEdit(fact)}
                            size="sm"
                            variant="outline"
                          >
                            <PencilIcon /> Edit / retype
                          </Button>
                        </div>
                      )}
                      {fact.accepted && (
                        <div className="text-success text-xs font-semibold">
                          Confirmed by reviewer
                        </div>
                      )}
                    </div>
                  )}
                </TableCell>
                <TableCell className="max-w-0 min-w-0 py-3 wrap-break-word whitespace-normal">
                  <div className="text-muted-foreground text-xs leading-relaxed">
                    {fact.source} · {fact.page}
                    <div className="mt-0.5">
                      {fact.date} · {fact.kind}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="py-3">
                  <Select
                    onValueChange={(value) => {
                      if (value !== null) {
                        setFactConfidence(fact.id, value);
                      }
                    }}
                    value={fact.confidence}
                  >
                    <SelectTrigger
                      aria-label="Interpretive confidence"
                      size="sm"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONFIDENCE_LEVELS.map((level) => (
                        <SelectItem key={level} value={level}>
                          {level}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-muted-foreground py-3 text-xs">
                  {fact.period}
                </TableCell>
                <TableCell className="py-3 text-end">
                  <Button
                    aria-label="Edit fact"
                    disabled={editingId !== null}
                    onClick={() => startEdit(fact)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <PencilIcon />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
