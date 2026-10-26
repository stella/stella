import { useRef } from "react";

import { Result } from "better-result";

import { ScrollArea } from "@stll/ui/scroll-area";

import { AnnotationToolbar } from "@/components/legal-reader/annotations/annotation-toolbar";

const paragraph =
  "The court of appeal confirmed the judgment of the first instance court and held that the contract was void for its conflict with good morals. ";

/** A scrolling reader with spaced paragraphs and its selection toolbar. */
export const ReaderSelectionPlayground = () => {
  const root = useRef<HTMLDivElement>(null);
  return (
    <div className="p-6">
      <ScrollArea
        axis="vertical"
        className="h-[600px] w-[520px]"
        viewportRef={root}
      >
        <article
          className="reader-body px-12 py-6 leading-relaxed"
          data-testid="reader"
        >
          {Array.from({ length: 14 }, (_, index) => (
            <p className="mb-6" data-anchor={`p-${index}`} key={index}>
              {paragraph.repeat(2)}
            </p>
          ))}
        </article>
      </ScrollArea>
      <p data-testid="after-reader">Text after the reader.</p>
      <AnnotationToolbar
        activeAnnotation={null}
        activeSpans={[]}
        controller={{
          create: async () => Result.ok(undefined),
          redo: async () => await Promise.resolve(),
          remove: async () => Result.ok(undefined),
          undo: async () => await Promise.resolve(),
          update: async () => Result.ok(undefined),
        }}
        mode="authenticated"
        onActivateAnnotation={() => undefined}
        onClearActive={() => undefined}
        onExplain={() => undefined}
        scrollContainerRef={root}
        target={{
          type: "decision",
          id: "00000000-0000-4000-8000-000000000821",
          caseNumber: "1 Cdo 1/2026",
          caseNumberType: "case-number",
          country: "CZ",
          court: "Court",
          decisionDate: null,
          decisionType: null,
          ecli: null,
          name: null,
        }}
      />
    </div>
  );
};
