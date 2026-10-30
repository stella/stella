import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import * as pele from "pele/lazy";
import { IntlProvider } from "use-intl";

import { renderDiagram } from "@/components/ai-elements/mermaid-diagram";
import {
  DiagramBlockView,
  diagramZoom,
} from "@/components/ai-elements/mermaid-diagram-block";
import type { DiagramBlockState } from "@/components/ai-elements/mermaid-diagram-block";
import en from "@/i18n/langs/en.json";

const FONTS = { fontFamily: "sans-serif", fontFamilyMono: "monospace" };

const HOSTILE_SOURCE =
  'flowchart TD\n  A["<img src=x onerror=alert(1)>"] --> B\n  B --> C["</code><script>alert(1)</script>"]';

const markupFor = (code: string, state: DiagramBlockState) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={en} timeZone="UTC">
      <DiagramBlockView code={code} state={state} />
    </IntlProvider>,
  );

describe("mermaid diagram block", () => {
  test("a pele render that throws shows the typed failure state with the source as text", async () => {
    const render = await renderDiagram({
      id: "d",
      source: HOSTILE_SOURCE,
      fonts: FONTS,
      loadEngine: async () => ({
        ...pele,
        render: () => {
          throw new pele.PeleError("unexpected token", "syntax");
        },
      }),
    });
    const markup = markupFor(HOSTILE_SOURCE, { kind: "settled", render });
    expect(markup).toContain('data-diagram-state="failed"');
    expect(markup).toContain('data-diagram-failure="syntax"');
    expect(markup).toContain(en.chat.diagramUnavailable);
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<svg");
  });

  test("a rendered diagram shows pele's svg and not the source", async () => {
    const render = await renderDiagram({
      id: "d",
      source: "flowchart TD\n  Start --> Finish",
      fonts: FONTS,
    });
    const markup = markupFor("flowchart TD\n  Start --> Finish", {
      kind: "settled",
      render,
    });
    expect(markup).toContain('data-diagram-state="rendered"');
    expect(markup).toContain('data-diagram-controls="true"');
    expect(markup).toContain('data-diagram-viewport="true"');
    expect(markup).toContain(`aria-label="${en.common.zoomOut}"`);
    expect(markup).toContain(`aria-label="${en.common.zoomIn}"`);
    expect(markup).toContain(`aria-label="${en.common.copy}"`);
    expect(markup).toContain(`aria-label="${en.common.download}"`);
    expect(markup).toContain("<svg");
    expect(markup).not.toContain("<pre");
  });

  test("zoom stays within the pannable diagram canvas bounds", () => {
    expect(diagramZoom(1, "out")).toBe(1);
    expect(diagramZoom(1, "in")).toBe(1.5);
    expect(diagramZoom(2, "out")).toBe(1.5);
    expect(diagramZoom(3, "in")).toBe(3);
  });

  test("a fence still streaming shows only its source", () => {
    const markup = markupFor("flowchart TD\n  A -->", { kind: "source" });
    expect(markup).toContain('data-diagram-state="source"');
    expect(markup).toContain("A --&gt;");
    expect(markup).not.toContain(en.chat.diagramUnavailable);
    expect(markup).not.toContain("<svg");
  });
});
