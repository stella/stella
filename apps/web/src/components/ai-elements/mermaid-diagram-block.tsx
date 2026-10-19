"use client";

import { useId } from "react";

import { useQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import type { CustomRenderer, CustomRendererProps } from "streamdown";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import {
  DiagramRenderFailure,
  documentFonts,
  renderDiagram,
} from "@/components/ai-elements/mermaid-diagram";
import type { DiagramRender } from "@/components/ai-elements/mermaid-diagram";

/**
 * What a fenced Mermaid block shows. Until a finished fence has rendered, the
 * reader sees its source; a failed render keeps the source and says so, never
 * a half-drawn or engine-provided error diagram.
 */
export type DiagramBlockState =
  | { kind: "source" }
  | { kind: "settled"; render: DiagramRender };

const CONTAINER_CLASS = "my-4 rounded-xl border p-4";

// Diagrams scale down to the column instead of scrolling sideways.
const DIAGRAM_CLASS = "[&>svg]:h-auto [&>svg]:max-w-full";

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
  return (
    <div
      className={cn(CONTAINER_CLASS, DIAGRAM_CLASS)}
      data-diagram-state="rendered"
      // safe-html: pele.render with links and images off (PELE_OPTIONS in mermaid-diagram.ts), pinned by its hostile-input property test
      dangerouslySetInnerHTML={{ __html: state.render.value.svg }}
    />
  );
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
