import { useCallback, useMemo, useRef, useState } from "react";

import { createFileRoute } from "@tanstack/react-router";

import {
  DEFAULT_ENTITY_LABELS,
  DETECTION_SOURCES,
  runPipeline,
} from "@stella/anonymize";
import type { Entity, PipelineConfig } from "@stella/anonymize";
import { Button } from "@stella/ui/components/button";

import { ENTITY_COLORS } from "@/lib/anonymize/ui-constants";

export const Route = createFileRoute("/_protected/dev/annotate")({
  component: AnnotatePage,
});

type AnnotatedEntity = Entity & {
  id: number;
  status: "pending" | "confirmed" | "rejected";
};

type GoldEntry = {
  start: number;
  end: number;
  label: string;
  text: string;
};

const QUICK_CONFIG: PipelineConfig = {
  threshold: 0.4,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableNameCorpus: true,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "dev-annotate",
};

const LABEL_OPTIONS = [...DEFAULT_ENTITY_LABELS];

const colorFor = (label: string): string =>
  ENTITY_COLORS[label] ?? "bg-gray-200 dark:bg-gray-700";

let nextId = 1;

const toAnnotated = (entities: Entity[]): AnnotatedEntity[] =>
  entities.map((e) => ({
    ...e,
    id: nextId++,
    status: "pending" as const,
  }));

function AnnotatePage() {
  const [inputText, setInputText] = useState("");
  const [text, setText] = useState("");
  const [entities, setEntities] = useState<AnnotatedEntity[]>([]);
  const [running, setRunning] = useState(false);
  const [filename, setFilename] = useState("untitled");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const textRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const entityRefs = useRef<Map<number, HTMLElement>>(new Map());

  // --- Pipeline ---
  const handleRun = useCallback(async () => {
    const src = inputText.trim();
    if (!src) return;
    setRunning(true);
    setText(src);
    try {
      const raw = await runPipeline(src, QUICK_CONFIG, [], null);
      setEntities(toAnnotated(raw));
    } finally {
      setRunning(false);
    }
  }, [inputText]);

  // --- File upload ---
  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setFilename(file.name.replace(/\.txt$/, ""));
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === "string") {
          setInputText(result);
        }
      };
      reader.readAsText(file);
    },
    [],
  );

  // --- Entity actions ---
  const toggleStatus = useCallback(
    (id: number, status: "confirmed" | "rejected") => {
      setEntities((prev) =>
        prev.map((e) =>
          e.id === id
            ? {
                ...e,
                status: e.status === status ? "pending" : status,
              }
            : e,
        ),
      );
    },
    [],
  );

  const relabel = useCallback((id: number, newLabel: string) => {
    setEntities((prev) =>
      prev.map((e) => (e.id === id ? { ...e, label: newLabel } : e)),
    );
  }, []);

  const removeEntity = useCallback((id: number) => {
    setEntities((prev) => prev.filter((e) => e.id !== id));
  }, []);

  // --- Text selection → add entity ---
  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !textRef.current) return;

    const range = sel.getRangeAt(0);
    const container = textRef.current;

    if (!container.contains(range.startContainer)) return;

    // Walk text nodes to compute character offset
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let startOffset = -1;
    let endOffset = -1;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node === range.startContainer) {
        startOffset = offset + range.startOffset;
      }
      if (node === range.endContainer) {
        endOffset = offset + range.endOffset;
        break;
      }
      offset += node.textContent?.length ?? 0;
    }

    if (startOffset < 0 || endOffset <= startOffset) return;

    const selectedText = text.slice(startOffset, endOffset);
    const label = prompt("Entity label:", "person");
    if (!label) return;

    const newEntity: AnnotatedEntity = {
      start: startOffset,
      end: endOffset,
      label,
      text: selectedText,
      score: 1.0,
      source: DETECTION_SOURCES.REGEX,
      id: nextId++,
      status: "confirmed",
    };

    setEntities((prev) =>
      [...prev, newEntity].toSorted((a, b) => a.start - b.start),
    );
    sel.removeAllRanges();
  }, [text]);

  // --- Export gold JSON ---
  const handleExport = useCallback(() => {
    const gold: GoldEntry[] = entities
      .filter((e) => e.status === "confirmed")
      .map(({ start, end, label, text: t }) => ({
        start,
        end,
        label,
        text: t,
      }));

    const blob = new Blob([JSON.stringify(gold, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.gold.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [entities, filename]);

  // --- Import gold JSON ---
  const handleImport = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const result = reader.result;
          if (typeof result !== "string") return;
          const gold = JSON.parse(result) as GoldEntry[];
          const imported: AnnotatedEntity[] = gold.map((g) => ({
            ...g,
            score: 1.0,
            source: DETECTION_SOURCES.REGEX,
            id: nextId++,
            status: "confirmed" as const,
          }));
          setEntities((prev) =>
            [...prev, ...imported].toSorted((a, b) => a.start - b.start),
          );
        } catch {
          // Invalid JSON — ignore
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, []);

  // --- Scroll sidebar → text ---
  const scrollToSpan = useCallback((id: number) => {
    setSelectedId(id);
    const el = document.querySelector(`[data-entity-id="${id}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  // --- Scroll text → sidebar ---
  const scrollToSidebar = useCallback((id: number) => {
    setSelectedId(id);
    const el = entityRefs.current.get(id);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  // --- Render highlighted text ---
  const renderedText = useMemo(() => {
    if (!text) return null;

    const sorted = entities
      .filter((e) => e.status !== "rejected")
      .toSorted((a, b) => a.start - b.start);

    const parts: React.ReactNode[] = [];
    let cursor = 0;

    for (const entity of sorted) {
      if (entity.start < cursor) continue;

      if (entity.start > cursor) {
        parts.push(text.slice(cursor, entity.start));
      }

      parts.push(
        <span
          key={entity.id}
          data-entity-id={entity.id}
          className={`${colorFor(entity.label)} cursor-pointer rounded-sm px-0.5 ${
            selectedId === entity.id ? "ring-foreground ring-2" : ""
          }`}
          title={`${entity.label} (${entity.source})`}
          onClick={() => scrollToSidebar(entity.id)}
        >
          {text.slice(entity.start, entity.end)}
        </span>,
      );
      cursor = entity.end;
    }

    if (cursor < text.length) {
      parts.push(text.slice(cursor));
    }

    return parts;
  }, [text, entities, selectedId, scrollToSidebar]);

  const confirmedCount = entities.filter(
    (e) => e.status === "confirmed",
  ).length;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <h1 className="text-lg font-semibold">Anonymise Annotator</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleImport}>
            Import Gold
          </Button>
          <Button
            size="sm"
            onClick={handleExport}
            disabled={confirmedCount === 0}
          >
            Export Gold ({confirmedCount})
          </Button>
        </div>
      </div>

      {/* Main area */}
      <div className="flex min-h-0 flex-1">
        {/* Text view */}
        <div className="flex-1 overflow-auto border-r p-4">
          {text ? (
            <div
              ref={textRef}
              className="text-sm leading-relaxed"
              style={{ whiteSpace: "pre-wrap" }}
              onMouseUp={handleMouseUp}
            >
              {renderedText}
            </div>
          ) : (
            <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
              Paste text or upload a file, then run the pipeline.
            </div>
          )}
        </div>

        {/* Entity sidebar */}
        <div className="flex w-80 flex-col overflow-auto p-3">
          <div className="text-muted-foreground mb-2 text-xs font-medium">
            Entities ({entities.length})
          </div>
          <div className="flex flex-col gap-1.5 overflow-auto">
            {entities.map((e) => (
              <div
                key={e.id}
                ref={(el) => {
                  if (el) entityRefs.current.set(e.id, el);
                }}
                className={`rounded border p-2 text-xs ${
                  selectedId === e.id ? "border-foreground" : "border-border"
                } ${e.status === "rejected" ? "opacity-40" : ""}`}
              >
                <div className="flex items-start justify-between gap-1">
                  <button
                    type="button"
                    className={`${colorFor(e.label)} cursor-pointer truncate rounded px-1 font-mono`}
                    onClick={() => scrollToSpan(e.id)}
                    title="Scroll to span"
                  >
                    {e.text}
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive shrink-0 cursor-pointer text-xs"
                    onClick={() => removeEntity(e.id)}
                    title="Delete entity"
                  >
                    &times;
                  </button>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <select
                    className="bg-muted rounded px-1 py-0.5 text-xs"
                    value={e.label}
                    onChange={(ev) => relabel(e.id, ev.target.value)}
                  >
                    {LABEL_OPTIONS.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                    {!(LABEL_OPTIONS as readonly string[]).includes(
                      e.label,
                    ) && <option value={e.label}>{e.label}</option>}
                  </select>
                  <span className="text-muted-foreground">{e.source}</span>
                  <span className="text-muted-foreground">
                    {e.score.toFixed(2)}
                  </span>
                </div>
                <div className="mt-1 flex gap-1">
                  <button
                    type="button"
                    className={`cursor-pointer rounded px-1.5 py-0.5 ${
                      e.status === "confirmed"
                        ? "bg-green-200 dark:bg-green-800"
                        : "bg-muted"
                    }`}
                    onClick={() => toggleStatus(e.id, "confirmed")}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    className={`cursor-pointer rounded px-1.5 py-0.5 ${
                      e.status === "rejected"
                        ? "bg-red-200 dark:bg-red-800"
                        : "bg-muted"
                    }`}
                    onClick={() => toggleStatus(e.id, "rejected")}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Input bar */}
      <div className="flex items-end gap-2 border-t p-3">
        <textarea
          className="bg-muted min-h-[60px] flex-1 rounded border p-2 text-sm"
          placeholder="Paste text here..."
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
        />
        <div className="flex flex-col gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt"
            className="hidden"
            onChange={handleFileUpload}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
          >
            Upload .txt
          </Button>
          <Button
            size="sm"
            onClick={handleRun}
            disabled={running || !inputText.trim()}
          >
            {running ? "Running..." : "Run Pipeline"}
          </Button>
        </div>
      </div>
    </div>
  );
}
