"use client";

import { useId, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import type { CustomRenderer, CustomRendererProps } from "streamdown";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  DownloadIcon,
  Maximize2Icon,
  MinusIcon,
  PlusIcon,
} from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import {
  DiagramRenderFailure,
  documentFonts,
  renderDiagram,
} from "@/components/ai-elements/mermaid-diagram";
import type { DiagramRender } from "@/components/ai-elements/mermaid-diagram";
import { CopyActionButton } from "@/components/copy-action-button";
import { detached } from "@/lib/detached";

/**
 * What a fenced Mermaid block shows. Until a finished fence has rendered, the
 * reader sees its source; a failed render keeps the source and says so, never
 * a half-drawn or engine-provided error diagram.
 */
export type DiagramBlockState =
  { kind: "source" } | { kind: "settled"; render: DiagramRender };

const CONTAINER_CLASS = "my-4 rounded-xl border p-4";

// Diagrams scale down to the column instead of scrolling sideways.
const DIAGRAM_CLASS = "[&>svg]:h-auto [&>svg]:max-w-full";
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.5;

const DiagramSource = ({ code }: { code: string }) => (
  <pre className="font-mono text-sm wrap-break-word whitespace-pre-wrap">
    <code>{code}</code>
  </pre>
);

export const DiagramBlockView = ({
  code,
  state,
}: {
  code: string;
  state: DiagramBlockState;
}) => {
  const t = useTranslations();
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  if (state.kind === "source") {
    return (
      <div className={CONTAINER_CLASS} data-diagram-state="source">
        <DiagramSource code={code} />
      </div>
    );
  }
  if (Result.isError(state.render)) {
    return (
      <div
        className={CONTAINER_CLASS}
        data-diagram-state="failed"
        data-diagram-failure={state.render.error.reason}
      >
        <p className="text-muted-foreground mb-2 text-sm">
          {t("chat.diagramUnavailable")}
        </p>
        <DiagramSource code={code} />
      </div>
    );
  }
  const svg = state.render.value.svg;
  return (
    <div
      className={cn(CONTAINER_CLASS, "relative")}
      data-diagram-state="rendered"
      ref={containerRef}
    >
      <div className="mb-2 flex justify-end gap-1" data-diagram-controls="true">
        <Button
          aria-label={t("common.zoomOut")}
          disabled={zoom === MIN_ZOOM}
          onClick={() => setZoom((value) => diagramZoom(value, "out"))}
          size="icon-xs"
          variant="ghost"
        >
          <MinusIcon className="size-3" />
        </Button>
        <Button
          aria-label={t("common.zoomIn")}
          disabled={zoom === MAX_ZOOM}
          onClick={() => setZoom((value) => diagramZoom(value, "in"))}
          size="icon-xs"
          variant="ghost"
        >
          <PlusIcon className="size-3" />
        </Button>
        <CopyActionButton
          iconClassName="size-3"
          iconOnly
          size="icon-xs"
          text={svg}
          variant="ghost"
        />
        <Button
          aria-label={t("common.download")}
          onClick={() => downloadSvg(svg)}
          size="icon-xs"
          variant="ghost"
        >
          <DownloadIcon className="size-3" />
        </Button>
        <Button
          aria-label={t("common.open")}
          onClick={() => {
            const request = containerRef.current?.requestFullscreen();
            if (request) {
              detached(request, "mermaid-diagram.fullscreen");
            }
          }}
          size="icon-xs"
          variant="ghost"
        >
          <Maximize2Icon className="size-3" />
        </Button>
      </div>
      <ScrollArea data-diagram-viewport="true">
        <div
          className={DIAGRAM_CLASS}
          // Zoom changes the canvas width, so the viewport provides native mouse,
          // touch and keyboard panning without a second gesture implementation.
          style={{ width: `${zoom * 100}%` }}
          // safe-html: pele.render with links and images off (PELE_OPTIONS in mermaid-diagram.ts), pinned by its hostile-input property test
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </ScrollArea>
    </div>
  );
};

export const diagramZoom = (value: number, direction: "in" | "out") =>
  Math.max(
    MIN_ZOOM,
    Math.min(MAX_ZOOM, value + (direction === "in" ? ZOOM_STEP : -ZOOM_STEP)),
  );

const downloadSvg = (svg: string) => {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "diagram.svg";
  link.click();
  URL.revokeObjectURL(url);
};

const MermaidDiagramBlock = ({ code, isIncomplete }: CustomRendererProps) => {
  const idPrefix = `diagram-${useId().replaceAll(/[^a-zA-Z0-9]/gu, "")}`;
  const diagram = useQuery({
    queryKey: ["chat-diagram", idPrefix, code],
    queryFn: async () =>
      renderDiagram({
        id: idPrefix,
        source: code,
        fonts: await documentFonts(),
      }),
    enabled: !isIncomplete,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return (
    <DiagramBlockView
      code={code}
      state={blockState(
        isIncomplete,
        diagram.status,
        diagram.data,
        diagram.error,
      )}
    />
  );
};

// `renderDiagram` resolves every failure as a value, so a query error can
// only be the render task itself breaking; it still ends in the typed state.
const blockState = (
  isIncomplete: boolean,
  status: "pending" | "error" | "success",
  data: DiagramRender | undefined,
  error: Error | null,
): DiagramBlockState => {
  if (isIncomplete) {
    return { kind: "source" };
  }
  if (status === "error") {
    return {
      kind: "settled",
      render: Result.err(
        new DiagramRenderFailure({
          reason: "engine-unavailable",
          message: error?.message ?? "The diagram could not be rendered.",
          cause: error,
        }),
      ),
    };
  }
  return data === undefined
    ? { kind: "source" }
    : { kind: "settled", render: data };
};

export const mermaidDiagramRenderer = {
  language: "mermaid",
  component: MermaidDiagramBlock,
} as const satisfies CustomRenderer;
