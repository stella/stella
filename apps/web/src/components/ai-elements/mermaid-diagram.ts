import type { RenderOptions } from "pele";
import type { DiagramPlugin } from "streamdown";

type DiagramSvg = { svg: string };

type DiagramFonts = Required<
  Pick<RenderOptions, "fontFamily" | "fontFamilyMono">
>;

const PELE_OPTIONS = {
  links: false,
  images: false,
} as const satisfies RenderOptions;

type RenderDiagramArgs = {
  id: string;
  source: string;
  fonts: DiagramFonts;
  fallback: (id: string, source: string) => Promise<DiagramSvg>;
};

export const renderDiagram = async ({
  id,
  source,
  fonts,
  fallback,
}: RenderDiagramArgs): Promise<DiagramSvg> => {
  const pele = await import("pele/lazy");
  if (!(await pele.load(pele.detectType(source)))) {
    return fallback(id, source);
  }
  return {
    svg: pele.render(source, { ...PELE_OPTIONS, ...fonts, idPrefix: id }).svg,
  };
};

const renderWithMermaid = async (id: string, source: string) => {
  const { mermaid } = await import("@streamdown/mermaid");
  return mermaid.getMermaid().render(id, source);
};

const documentFonts = async (): Promise<DiagramFonts> => {
  await document.fonts.ready;
  return {
    fontFamily: getComputedStyle(document.body).fontFamily,
    fontFamilyMono: getComputedStyle(document.documentElement)
      .getPropertyValue("--font-mono")
      .trim(),
  };
};

export const mermaidDiagram = {
  name: "mermaid",
  type: "diagram",
  language: "mermaid",
  getMermaid: () => ({
    initialize: () => undefined,
    render: async (id: string, source: string) =>
      renderDiagram({
        id,
        source,
        fonts: await documentFonts(),
        fallback: renderWithMermaid,
      }),
  }),
} as const satisfies DiagramPlugin;
