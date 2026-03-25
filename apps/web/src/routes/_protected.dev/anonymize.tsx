// TODO: FIXME — anonymize feature uses untyped third-party libs (onnxruntime-web, idb)
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildUnifiedSearch,
  chunkText,
  computeChunkOffsets,
  DEFAULT_ENTITY_LABELS,
  DEFAULT_OPERATOR_CONFIG,
  DETECTION_SOURCES,
  exportRedactionKey,
  mergeChunkEntities,
  OPERATOR_TYPES,
  processRegexMatches,
  redactText,
  resolveOperator,
  runPipeline,
  runUnifiedSearch,
} from "@stll/anonymize";
import type {
  Entity,
  GazetteerEntry,
  NerInferenceFn,
  OperatorConfig,
  OperatorType,
  PipelineConfig,
  ReviewDecision,
  ReviewedEntity,
} from "@stll/anonymize";
import { createFileRoute } from "@tanstack/react-router";
import { nanoid } from "nanoid";

import { Button } from "@stella/ui/components/button";

import { getEntries, putEntry } from "@/lib/anonymize/gazetteer";
import type { CharSpan } from "@/lib/anonymize/pdf-coords";
import { extractPDFText } from "@/lib/anonymize/pdf-coords";
import { redactPdf } from "@/lib/anonymize/pdf-redact";
import { saveRedactionMap } from "@/lib/anonymize/redaction-map";
import { getEntityColor, MODEL_OPTIONS } from "@/lib/anonymize/ui-constants";

const OPERATOR_TYPE_SET: ReadonlySet<string> = new Set(OPERATOR_TYPES);

const isOperatorType = (value: string): value is OperatorType =>
  OPERATOR_TYPE_SET.has(value);

export const Route = createFileRoute("/_protected/dev/anonymize")({
  component: AnonymizePage,
});

type Status =
  | "idle"
  | "loading-model"
  | "model-ready"
  | "extracting-text"
  | "running-pipeline"
  | "done";

const WORKSPACE_ID = "dev-workspace";

function AnonymizePage() {
  const workerRef = useRef<Worker | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [entities, setEntities] = useState<ReviewedEntity[]>([]);
  const [customLabels, setCustomLabels] = useState<string[]>([]);
  const allLabels = [...DEFAULT_ENTITY_LABELS, ...customLabels];
  const [selectedLabels, setSelectedLabels] = useState<string[]>([
    ...DEFAULT_ENTITY_LABELS,
  ]);
  const [showRegex, setShowRegex] = useState(true);
  const [threshold, setThreshold] = useState(0.3);
  const [selectedModel, setSelectedModel] = useState(
    MODEL_OPTIONS.find((m) => m.id === "pii-edge")?.id ??
      MODEL_OPTIONS[0]?.id ??
      "",
  );
  const [backend, setBackend] = useState("");
  const [downloadProgress, setDownloadProgress] = useState<{
    percent: number;
    downloadedMb: number;
    totalMb: number;
  } | null>(null);
  const [fileName, setFileName] = useState("");
  const [reviewMode, setReviewMode] = useState(false);
  const [redactedText, setRedactedText] = useState<string | null>(null);
  const [redactionKey, setRedactionKey] = useState<string | null>(null);
  const [operatorConfig, setOperatorConfig] = useState<OperatorConfig>(() => ({
    ...DEFAULT_OPERATOR_CONFIG,
  }));
  // PDF-specific state
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfSpans, setPdfSpans] = useState<CharSpan[]>([]);
  const [redactedPdfBytes, setRedactedPdfBytes] = useState<Uint8Array | null>(
    null,
  );
  const [showPdfPreview, setShowPdfPreview] = useState(false);
  const [showRedactionMap, setShowRedactionMap] = useState(false);
  const [redactionEntries, setRedactionEntries] = useState<
    { placeholder: string; original: string; operator: string }[]
  >([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Terminate worker on unmount to prevent resource leak
  // eslint-disable-next-line arrow-body-style -- cleanup-only effect
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const log = useCallback((msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  // ── Model lifecycle ────────────────────────────────

  const initModel = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }

    const model =
      MODEL_OPTIONS.find((m) => m.id === selectedModel) ?? MODEL_OPTIONS[0];
    if (!model) {
      return;
    }

    setStatus("loading-model");
    log(`Loading model: ${model.label}`);

    const worker = new Worker(new URL("-gliner-worker.ts", import.meta.url), {
      type: "module",
    });

    let initialized = false;

    worker.addEventListener("message", (event: MessageEvent) => {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
      const msg = event.data;
      // oxlint-disable-next-line typescript-eslint/no-unsafe-member-access
      switch (msg.type) {
        case "init-progress":
          // oxlint-disable-next-line typescript-eslint/no-unsafe-argument, typescript-eslint/no-unsafe-member-access
          log(msg.message);
          break;
        case "download-progress":
          setDownloadProgress({
            // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-member-access
            percent: msg.percent,
            // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-member-access
            downloadedMb: msg.downloadedMb,
            // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-member-access
            totalMb: msg.totalMb,
          });
          break;
        case "init-done":
          initialized = true;
          setDownloadProgress(null);
          setStatus("model-ready");
          // oxlint-disable-next-line typescript-eslint/no-unsafe-argument, typescript-eslint/no-unsafe-member-access
          setBackend(msg.backend);
          // oxlint-disable-next-line typescript-eslint/no-unsafe-member-access
          log(`Model ready (${msg.backend})`);
          break;
        case "error":
          // oxlint-disable-next-line typescript-eslint/no-unsafe-member-access
          log(`ERROR: ${msg.message}`);
          // Only reset on init errors; inference errors
          // should not destroy the worker ref
          if (!initialized) {
            setStatus("idle");
            workerRef.current = null;
          }
          break;
        default:
          break;
      }
    });

    workerRef.current = worker;
    worker.postMessage({
      type: "init",
      modelPath: model.url,
      tokenizerPath: model.tokenizer,
      // eslint-disable-next-line unicorn/require-post-message-target-origin
    });
  }, [log, selectedModel]);

  // ── NER inference callback for pipeline ────────────

  const nerInference: NerInferenceFn = useCallback(
    async (
      fullText: string,
      labels: string[],
      thresh: number,
    ): Promise<Entity[]> => {
      if (!workerRef.current) {
        return [];
      }

      const chunks = chunkText(fullText);
      const chunkOffsets = computeChunkOffsets(fullText, chunks);
      const allChunkResults: Entity[][] = [];

      for (const chunk of chunks) {
        const result = await new Promise<Entity[]>((resolve) => {
          const handler = (event: MessageEvent) => {
            // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
            const msg = event.data;
            // oxlint-disable-next-line typescript-eslint/no-unsafe-member-access
            if (msg.type === "inference-done") {
              // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access
              const ents = (msg.results[0] ?? []).map(
                (e: {
                  start: number;
                  end: number;
                  label: string;
                  text?: string;
                  spanText?: string;
                  score?: number;
                  probability?: number;
                }) => ({
                  start: e.start,
                  end: e.end,
                  label: e.label,
                  text: e.text ?? e.spanText ?? "",
                  score: e.score ?? e.probability ?? 0,
                  source: DETECTION_SOURCES.NER,
                }),
              );
              workerRef.current?.removeEventListener("message", handler);
              // oxlint-disable-next-line typescript-eslint/no-unsafe-argument
              resolve(ents);
              // oxlint-disable-next-line typescript-eslint/no-unsafe-member-access
            } else if (msg.type === "error") {
              workerRef.current?.removeEventListener("message", handler);
              resolve([]);
            }
          };

          if (!workerRef.current) {
            resolve([]);
            return;
          }

          workerRef.current.addEventListener("message", handler);
          workerRef.current.postMessage({
            type: "inference",
            texts: [chunk],
            entities: labels,
            threshold: thresh,
            // eslint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin
          });
        });
        allChunkResults.push(result);
      }

      return mergeChunkEntities(chunkOffsets, allChunkResults);
    },
    [],
  );

  // ── Full pipeline run ──────────────────────────────

  const runFullPipeline = useCallback(
    async (inputText: string) => {
      setText(inputText);
      setEntities([]);
      setRedactedText(null);
      setRedactionKey(null);
      setRedactedPdfBytes(null);
      setShowPdfPreview(false);
      setShowRedactionMap(false);
      setRedactionEntries([]);
      setOperatorConfig({ ...DEFAULT_OPERATOR_CONFIG });
      setStatus("running-pipeline");

      try {
        const gazetteerEntries = await getEntries(WORKSPACE_ID);

        const config: PipelineConfig = {
          threshold,
          enableTriggerPhrases: true,
          enableRegex: true,
          enableNameCorpus: true,
          enableDenyList: false,
          enableGazetteer: gazetteerEntries.length > 0,
          enableNer: workerRef.current !== null,
          enableConfidenceBoost: true,
          enableCoreference: true,
          labels: selectedLabels,
          workspaceId: WORKSPACE_ID,
        };

        const result = await runPipeline({
          fullText: inputText,
          config,
          gazetteerEntries,
          nerInference: workerRef.current ? nerInference : null,
          onProgress: (step, detail) => log(`[${step}] ${detail}`),
        });

        setEntities(result);
        log(`Pipeline complete: ${result.length} entities`);
        setStatus("done");
      } catch (error) {
        // oxlint-disable-next-line no-console
        console.error("Pipeline failed:", error);
        log(`Error: ${error instanceof Error ? error.message : String(error)}`);
        setStatus("idle");
      }
    },
    [log, selectedLabels, threshold, nerInference],
  );

  // ── Regex-only shortcut ────────────────────────────

  const runRegexOnly = useCallback(
    async (inputText: string) => {
      setText(inputText);
      setRedactedText(null);
      setRedactionKey(null);
      setRedactedPdfBytes(null);
      setPdfBytes(null);
      setPdfSpans([]);
      setShowPdfPreview(false);
      setShowRedactionMap(false);
      setRedactionEntries([]);
      setOperatorConfig({ ...DEFAULT_OPERATOR_CONFIG });
      try {
        const regexConfig: PipelineConfig = {
          threshold: 0,
          enableTriggerPhrases: false,
          enableRegex: true,
          enableNameCorpus: false,
          enableDenyList: false,
          enableGazetteer: false,
          enableNer: false,
          enableConfidenceBoost: false,
          enableCoreference: false,
          labels: [],
          workspaceId: "dev",
        };
        const search = await buildUnifiedSearch(regexConfig);
        const { regexMatches } = runUnifiedSearch(search, inputText);
        const regexResults = processRegexMatches(
          regexMatches,
          search.slices.regex.start,
          search.slices.regex.end,
          search.regexMeta,
        );
        setEntities(regexResults);
        log(`Regex-only: ${regexResults.length} matches`);
        setStatus("done");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Regex-only failed: ${message}`);
        setStatus("idle");
      }
    },
    [log],
  );

  // ── File upload ────────────────────────────────────

  const handleFileUpload = useCallback(
    async (file: File) => {
      setFileName(file.name);
      setStatus("extracting-text");
      log(`Extracting text from ${file.name}...`);

      try {
        let extracted: string;
        const lowerName = file.name.toLowerCase();

        if (lowerName.endsWith(".pdf")) {
          const buffer = await file.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          setPdfBytes(bytes);

          // Dynamic import to avoid loading pdfjs-dist
          // eagerly when not needed
          const { getDocument, GlobalWorkerOptions } =
            await import("pdfjs-dist");
          if (!GlobalWorkerOptions.workerSrc) {
            GlobalWorkerOptions.workerSrc = (
              await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
            ).default;
          }
          // .slice() prevents pdfjs from transferring the
          // underlying ArrayBuffer, which would detach pdfBytes
          const pdf = await getDocument({ data: bytes.slice() }).promise;
          try {
            const result = await extractPDFText(pdf);
            extracted = result.text;
            setPdfSpans(result.spans);
            log(
              `PDF: ${result.pageCount} pages, ` +
                `${result.spans.length} text fragments`,
            );
          } finally {
            await pdf.destroy();
          }
        } else if (lowerName.endsWith(".txt")) {
          extracted = await file.text();
          setPdfBytes(null);
          setPdfSpans([]);
        } else {
          throw new Error(
            `Unsupported file type: ${lowerName}. Only PDF and TXT are supported.`,
          );
        }

        log(
          `Extracted ${extracted.length} characters ` +
            `(~${Math.ceil(extracted.length / 4)} tokens)`,
        );
        await runFullPipeline(extracted);
      } catch (error) {
        // oxlint-disable-next-line no-console
        console.error("File extraction failed:", error);
        log(`Error: ${error instanceof Error ? error.message : String(error)}`);
        setStatus("idle");
      }
    },
    [log, runFullPipeline],
  );

  // ── Review actions ─────────────────────────────────

  const reviewEntity = useCallback(
    (index: number, decision: ReviewDecision, newLabel?: string) => {
      setEntities((prev) => {
        const updated = [...prev];
        const existing = updated[index];
        if (!existing) {
          return prev;
        }
        const entity = { ...existing };
        entity.decision = decision;
        if (decision === "relabeled" && newLabel) {
          entity.originalLabel = entity.label;
          entity.label = newLabel;
        }
        updated[index] = entity;
        return updated;
      });
    },
    [],
  );

  const addToGazetteer = useCallback(
    async (entity: Entity) => {
      const entry: GazetteerEntry = {
        id: nanoid(),
        canonical: entity.text,
        label: entity.label,
        variants: [],
        workspaceId: WORKSPACE_ID,
        createdAt: Date.now(),
        source: "confirmed-from-model",
      };
      await putEntry(entry);
      log(`Added "${entity.text}" to deny list as ${entity.label}`);
    },
    [log],
  );

  // ── Redaction ──────────────────────────────────────

  const handleRedact = useCallback(async () => {
    const confirmed = entities.filter((e) => e.decision !== "rejected");
    const result = redactText(text, confirmed, operatorConfig);
    setRedactedText(result.redactedText);
    setRedactionKey(
      exportRedactionKey(result.redactionMap, result.operatorMap),
    );
    log(`Redacted ${result.entityCount} entity spans`);

    // Build redaction map entries for display
    const entries: {
      placeholder: string;
      original: string;
      operator: string;
    }[] = [];
    for (const [placeholder, original] of result.redactionMap) {
      entries.push({
        placeholder,
        original,
        operator: result.operatorMap.get(placeholder) ?? "replace",
      });
    }
    setRedactionEntries(entries);

    // Persist redaction map to IndexedDB
    const docId = fileName || `paste-${Date.now()}`;
    saveRedactionMap(
      docId,
      fileName || "Pasted text",
      result.redactionMap,
      result.operatorMap,
    ).catch((_error: unknown) => {
      log("Failed to persist redaction map to IndexedDB");
    });

    // If we have a PDF loaded, produce the redacted PDF too
    if (pdfBytes && pdfSpans.length > 0) {
      try {
        const pdfResult = await redactPdf(
          pdfBytes,
          text,
          pdfSpans,
          confirmed,
          operatorConfig,
        );
        setRedactedPdfBytes(pdfResult.pdfBytes);
        log(
          `PDF redaction complete ` +
            `(${(pdfResult.pdfBytes.length / 1024).toFixed(0)} KB)`,
        );
      } catch (error) {
        log(
          `PDF redaction error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }, [entities, text, log, operatorConfig, pdfBytes, pdfSpans, fileName]);

  // ── PDF preview URL ────────────────────────────────

  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!redactedPdfBytes) {
      setPdfPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(redactedPdfBytes)], {
        type: "application/pdf",
      }),
    );
    setPdfPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [redactedPdfBytes]);

  // ── Paste text ─────────────────────────────────────

  const [pasteText, setPasteText] = useState("");

  // ── Filtering ──────────────────────────────────────

  const filteredEntities = useMemo(() => {
    let filtered = entities;
    if (!showRegex) {
      filtered = filtered.filter((e) => e.source !== DETECTION_SOURCES.REGEX);
    }
    if (reviewMode) {
      filtered = filtered.filter((e) => e.score < threshold + 0.1);
    }
    return filtered;
  }, [entities, showRegex, reviewMode, threshold]);

  // ── Annotated text render ──────────────────────────

  const renderAnnotatedText = () => {
    if (!text || filteredEntities.length === 0) {
      return null;
    }

    const sorted = filteredEntities.toSorted((a, b) => a.start - b.start);
    const parts: React.ReactNode[] = [];
    let lastEnd = 0;

    for (const entity of sorted) {
      if (entity.start < lastEnd) {
        continue;
      }
      if (entity.decision === "rejected") {
        continue;
      }

      if (entity.start > lastEnd) {
        parts.push(
          <span key={`t-${lastEnd}`}>{text.slice(lastEnd, entity.start)}</span>,
        );
      }

      const opacity =
        entity.score >= 0.9
          ? "opacity-100"
          : entity.score >= 0.5
            ? "opacity-80"
            : "opacity-60";

      parts.push(
        <mark
          className={`${opacity} hover:border-foreground/30 cursor-help rounded border border-transparent px-0.5 transition-colors`}
          key={`e-${entity.start}`}
          style={{ backgroundColor: getEntityColor(entity.label) }}
          title={`${entity.label} (${(entity.score * 100).toFixed(0)}%) [${entity.source}]`}
        >
          {text.slice(entity.start, entity.end)}
        </mark>,
      );

      lastEnd = entity.end;
    }

    if (lastEnd < text.length) {
      parts.push(<span key={`t-${lastEnd}`}>{text.slice(lastEnd)}</span>);
    }

    return parts;
  };

  // ── Label toggle ───────────────────────────────────

  const toggleLabel = (label: string) => {
    setSelectedLabels((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
    );
  };

  // ── Render ─────────────────────────────────────────

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Local Anonymisation</h1>
          <p className="text-muted-foreground text-sm">
            Client-side PII detection and redaction; no data leaves your browser
          </p>
        </div>
        {backend && (
          <span className="bg-muted rounded px-2 py-1 font-mono text-xs">
            {backend}
          </span>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex items-center gap-3">
          <select
            className="rounded-md border bg-transparent px-2 py-1.5 text-sm"
            disabled={
              status === "loading-model" || status === "running-pipeline"
            }
            onChange={(e) => {
              setSelectedModel(e.target.value);
              if (workerRef.current) {
                workerRef.current.terminate();
                workerRef.current = null;
                setStatus("idle");
                setBackend("");
              }
            }}
            value={selectedModel}
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <Button
            disabled={
              status === "loading-model" ||
              status === "running-pipeline" ||
              status === "extracting-text"
            }
            onClick={initModel}
          >
            {status === "loading-model"
              ? downloadProgress
                ? `Downloading... ${downloadProgress.percent}%`
                : "Initializing..."
              : status === "idle"
                ? "Load Model"
                : "Reload Model"}
          </Button>
          {downloadProgress && (
            <div className="flex max-w-xs flex-1 items-center gap-2">
              <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
                <div
                  className="bg-foreground/70 h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${downloadProgress.percent}%`,
                  }}
                />
              </div>
              <span className="text-muted-foreground font-mono text-xs whitespace-nowrap">
                {downloadProgress.downloadedMb}/{downloadProgress.totalMb} MB
              </span>
            </div>
          )}

          <Button
            disabled={status !== "model-ready" && status !== "done"}
            onClick={() => inputRef.current?.click()}
          >
            Upload File
          </Button>

          {fileName && (
            <span className="text-muted-foreground text-sm">{fileName}</span>
          )}

          <input
            accept=".docx,.txt,.pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.item(0);
              if (file) {
                handleFileUpload(file).catch(() => {
                  /* fire-and-forget */
                });
              }
              e.target.value = "";
            }}
            ref={inputRef}
            type="file"
          />
        </div>

        {/* Paste area + actions */}
        <div className="flex gap-2">
          <textarea
            className="flex-1 resize-none rounded-md border bg-transparent px-3 py-2 font-mono text-sm"
            disabled={
              status === "loading-model" || status === "running-pipeline"
            }
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="Or paste text here..."
            rows={3}
            value={pasteText}
          />
          <div className="flex flex-col gap-1">
            <Button
              disabled={
                status === "running-pipeline" || pasteText.trim().length === 0
              }
              onClick={() => {
                setFileName("");
                setPdfBytes(null);
                setPdfSpans([]);
                runFullPipeline(pasteText).catch(() => {
                  /* fire-and-forget */
                });
              }}
            >
              Full Pipeline
            </Button>
            <Button
              disabled={pasteText.trim().length === 0}
              onClick={() => {
                setFileName("");
                void runRegexOnly(pasteText);
              }}
            >
              Regex Only
            </Button>
          </div>
        </div>

        {/* Label toggles */}
        <div className="flex flex-wrap items-center gap-1.5">
          {allLabels.map((label) => {
            const active = selectedLabels.includes(label);
            const isCustom = customLabels.includes(label);
            return (
              <button
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-opacity ${
                  active ? "opacity-100" : "opacity-40"
                } ${isCustom ? "border-dashed" : ""}`}
                style={{ backgroundColor: getEntityColor(label) }}
                key={label}
                onClick={() => toggleLabel(label)}
                onContextMenu={
                  isCustom
                    ? (e) => {
                        e.preventDefault();
                        setCustomLabels((prev) =>
                          prev.filter((l) => l !== label),
                        );
                        setSelectedLabels((prev) =>
                          prev.filter((l) => l !== label),
                        );
                      }
                    : undefined
                }
                title={
                  isCustom
                    ? "Click to toggle, right-click to remove"
                    : undefined
                }
                type="button"
              >
                {label}
              </button>
            );
          })}
          <form
            className="inline-flex"
            onSubmit={(e) => {
              e.preventDefault();
              const input = e.currentTarget.elements.namedItem("custom-label");
              if (!(input instanceof HTMLInputElement)) {
                return;
              }
              const value = input.value.trim().toLowerCase();
              if (value && !allLabels.includes(value)) {
                setCustomLabels((prev) => [...prev, value]);
                setSelectedLabels((prev) => [...prev, value]);
                input.value = "";
              }
            }}
          >
            <input
              className="placeholder:text-muted-foreground w-28 rounded-full border border-dashed bg-transparent px-2.5 py-0.5 text-xs"
              name="custom-label"
              placeholder="+ add label"
              type="text"
            />
          </form>

          <span className="text-muted-foreground mx-1 self-center text-xs">
            |
          </span>

          <button
            className={`rounded-full border px-2.5 py-0.5 text-xs transition-opacity ${
              showRegex
                ? "bg-gray-200 opacity-100 dark:bg-gray-700"
                : "opacity-40"
            }`}
            onClick={() => setShowRegex((v) => !v)}
            type="button"
          >
            regex patterns
          </button>

          <button
            className={`rounded-full border px-2.5 py-0.5 text-xs transition-opacity ${
              reviewMode
                ? "bg-amber-200 opacity-100 dark:bg-amber-800"
                : "opacity-40"
            }`}
            onClick={() => setReviewMode((v) => !v)}
            type="button"
          >
            review mode
          </button>
        </div>

        {/* Threshold + redact */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label
              className="text-muted-foreground text-xs"
              htmlFor="threshold"
            >
              Threshold:
            </label>
            <input
              className="w-32"
              id="threshold"
              max={0.9}
              min={0.01}
              onChange={(e) => setThreshold(Number(e.target.value))}
              step={0.05}
              type="range"
              value={threshold}
            />
            <span className="w-8 font-mono text-xs">
              {threshold.toFixed(2)}
            </span>
          </div>

          {status === "done" && entities.length > 0 && (
            <Button
              onClick={() => {
                handleRedact().catch((error: unknown) => {
                  log(`Unexpected redaction error: ${String(error)}`);
                });
              }}
            >
              Redact Document
            </Button>
          )}
        </div>
      </div>

      {/* Results area */}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* Annotated text / redacted output */}
        <div className="flex-1 overflow-auto rounded-lg border p-4">
          {status === "running-pipeline" && (
            <p className="text-muted-foreground animate-pulse text-sm">
              Running detection pipeline...
            </p>
          )}

          {redactedText !== null ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs font-medium">
                  Redacted output
                </span>
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      navigator.clipboard.writeText(redactedText).catch(() => {
                        /* fire-and-forget */
                      });
                      log("Redacted text copied to clipboard");
                    }}
                  >
                    Copy Text
                  </Button>
                  {redactionKey && (
                    <Button
                      onClick={() => {
                        navigator.clipboard
                          .writeText(redactionKey)
                          .catch(() => {
                            /* fire-and-forget */
                          });
                        log("Redaction key copied to clipboard");
                      }}
                    >
                      Copy Key
                    </Button>
                  )}
                  {redactedPdfBytes && (
                    <>
                      <Button
                        onClick={() => {
                          const blob = new Blob(
                            [new Uint8Array(redactedPdfBytes)],
                            { type: "application/pdf" },
                          );
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = fileName.replace(
                            /\.pdf$/i,
                            "_redacted.pdf",
                          );
                          a.click();
                          URL.revokeObjectURL(url);
                          log("Downloading redacted PDF");
                        }}
                      >
                        Download PDF
                      </Button>
                      <Button onClick={() => setShowPdfPreview((v) => !v)}>
                        {showPdfPreview ? "Hide Preview" : "Preview PDF"}
                      </Button>
                    </>
                  )}
                  {redactionEntries.length > 0 && (
                    <Button onClick={() => setShowRedactionMap((v) => !v)}>
                      {showRedactionMap ? "Hide Map" : "Redaction Map"}
                    </Button>
                  )}
                  <Button
                    onClick={() => {
                      setRedactedText(null);
                      setRedactionKey(null);
                      setRedactedPdfBytes(null);
                      setShowPdfPreview(false);
                      setShowRedactionMap(false);
                      setRedactionEntries([]);
                    }}
                  >
                    Back
                  </Button>
                </div>
              </div>
              <pre className="bg-muted/30 rounded p-3 font-mono text-sm leading-relaxed whitespace-pre-wrap">
                {redactedText}
              </pre>

              {/* PDF preview */}
              {showPdfPreview && pdfPreviewUrl && (
                <div className="mt-3">
                  <h4 className="text-muted-foreground mb-1 text-xs font-medium">
                    Anonymised PDF preview
                  </h4>
                  <iframe
                    className="h-[600px] w-full rounded border"
                    sandbox="allow-same-origin"
                    src={pdfPreviewUrl}
                    title="Anonymised PDF preview"
                  />
                </div>
              )}

              {/* Redaction map */}
              {showRedactionMap && redactionEntries.length > 0 && (
                <div className="mt-3">
                  <h4 className="text-muted-foreground mb-1 text-xs font-medium">
                    Redaction map ({redactionEntries.length} entries)
                  </h4>
                  <div className="bg-muted/30 overflow-auto rounded border">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b">
                          <th className="px-3 py-1.5 text-left font-medium">
                            Placeholder
                          </th>
                          <th className="px-3 py-1.5 text-left font-medium">
                            Original
                          </th>
                          <th className="px-3 py-1.5 text-left font-medium">
                            Operator
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {redactionEntries.map((entry) => (
                          <tr
                            className="border-b last:border-b-0"
                            key={entry.placeholder}
                          >
                            <td className="px-3 py-1 font-mono">
                              {entry.placeholder}
                            </td>
                            <td className="px-3 py-1">{entry.original}</td>
                            <td className="text-muted-foreground px-3 py-1">
                              {entry.operator}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : status === "done" && filteredEntities.length > 0 ? (
            <>
              <div className="text-muted-foreground mb-3 text-xs">
                {filteredEntities.length} entities found
                {!showRegex && entities.length !== filteredEntities.length
                  ? ` (${entities.length - filteredEntities.length} hidden)`
                  : ""}
                {reviewMode
                  ? " — review mode: showing low-confidence"
                  : " — hover for details, click for actions"}
              </div>
              <div className="text-sm leading-relaxed whitespace-pre-wrap">
                {renderAnnotatedText()}
              </div>
            </>
          ) : status === "done" && filteredEntities.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No entities found. Try lowering the threshold.
            </p>
          ) : (
            !text && (
              <p className="text-muted-foreground text-sm">
                Load the model, then upload a file (PDF, DOCX, TXT) or paste
                text to see results here.
              </p>
            )
          )}
        </div>

        {/* Entity sidebar */}
        {filteredEntities.length > 0 && redactedText === null && (
          <div className="w-96 overflow-auto rounded-lg border p-4">
            <h3 className="mb-2 text-sm font-semibold">Detected entities</h3>

            {/* Per-label operator config */}
            <div className="mb-3 border-b pb-3">
              <h4 className="text-muted-foreground mb-1 text-xs font-medium">
                Operators per label
              </h4>
              <div className="flex flex-col gap-1">
                {[...new Set(filteredEntities.map((e) => e.label))].map(
                  (label) => (
                    <div
                      className="flex items-center justify-between gap-2 text-xs"
                      key={label}
                    >
                      <span className="truncate">{label}</span>
                      <select
                        className="rounded border bg-transparent px-1 py-0.5 text-xs"
                        onChange={(e) => {
                          const value = e.target.value;
                          if (!isOperatorType(value)) {
                            return;
                          }
                          setOperatorConfig((prev) => ({
                            ...prev,
                            operators: {
                              ...prev.operators,
                              [label]: value,
                            },
                          }));
                        }}
                        value={resolveOperator(operatorConfig, label)}
                      >
                        {OPERATOR_TYPES.map((op) => (
                          <option key={op} value={op}>
                            {op}
                          </option>
                        ))}
                      </select>
                    </div>
                  ),
                )}
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">Redact string:</span>
                <input
                  className="flex-1 rounded border bg-transparent px-1.5 py-0.5 font-mono text-xs"
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val.length === 0) {
                      return;
                    }
                    setOperatorConfig((prev) => ({
                      ...prev,
                      redactString: val,
                    }));
                  }}
                  value={operatorConfig.redactString}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1">
              {filteredEntities.map((entity) => {
                const isRejected = entity.decision === "rejected";
                return (
                  <div
                    className={`group relative rounded px-2 py-1.5 text-xs ${
                      isRejected ? "line-through opacity-30" : ""
                    }`}
                    key={`${entity.start}-${entity.end}-${entity.label}`}
                    style={{ backgroundColor: getEntityColor(entity.label) }}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-medium">{entity.text}</span>
                        <span className="ml-1 opacity-60">
                          {entity.label} ({(entity.score * 100).toFixed(0)}%)
                        </span>
                        <span className="ml-1 opacity-40">
                          [{entity.source}]
                        </span>
                      </div>
                    </div>
                    <div className="mt-1 hidden gap-1 group-hover:flex">
                      <button
                        className="rounded bg-green-600/20 px-1.5 py-0.5 text-[10px] hover:bg-green-600/40"
                        onClick={() =>
                          reviewEntity(entities.indexOf(entity), "confirmed")
                        }
                        type="button"
                      >
                        confirm
                      </button>
                      <button
                        className="rounded bg-red-600/20 px-1.5 py-0.5 text-[10px] hover:bg-red-600/40"
                        onClick={() =>
                          reviewEntity(entities.indexOf(entity), "rejected")
                        }
                        type="button"
                      >
                        reject
                      </button>
                      <button
                        className="rounded bg-blue-600/20 px-1.5 py-0.5 text-[10px] hover:bg-blue-600/40"
                        onClick={() => {
                          addToGazetteer(entity).catch(() => {
                            /* fire-and-forget */
                          });
                        }}
                        type="button"
                      >
                        + deny list
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Logs */}
      <div className="bg-muted/30 h-40 overflow-auto rounded-lg border p-3 font-mono text-xs">
        {logs.length === 0 ? (
          <span className="text-muted-foreground">
            Logs will appear here...
          </span>
        ) : (
          logs.map((line, i) => <div key={i}>{line}</div>)
        )}
      </div>
    </div>
  );
}
