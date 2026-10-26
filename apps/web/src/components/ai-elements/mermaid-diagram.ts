import { Result, TaggedError } from "better-result";
import type { PeleErrorCode, RenderOptions } from "pele";
import type * as PeleLazy from "pele/lazy";

type DiagramFonts = Required<
  Pick<RenderOptions, "fontFamily" | "fontFamilyMono">
>;

const PELE_OPTIONS = {
  links: false,
  images: false,
} as const satisfies RenderOptions;

export type DiagramRenderFailureReason = PeleErrorCode | "engine-unavailable";

export class DiagramRenderFailure extends TaggedError("DiagramRenderFailure")<{
  reason: DiagramRenderFailureReason;
  message: string;
  cause?: unknown;
}> {}

type RenderedDiagram = { svg: string };

export type DiagramRender = Result<RenderedDiagram, DiagramRenderFailure>;

type DiagramEngine = Pick<
  typeof PeleLazy,
  "PeleError" | "detectType" | "load" | "render"
>;

const loadPele = async (): Promise<DiagramEngine> => import("pele/lazy");

type RenderDiagramArgs = {
  id: string;
  source: string;
  fonts: DiagramFonts;
  loadEngine?: () => Promise<DiagramEngine>;
};

/**
 * Renders a fenced Mermaid block with pele, the only diagram engine in the
 * app. Every way it can fail (no engine chunk, an unsupported diagram type, a
 * syntax or limit error thrown by the synchronous render) comes back as a
 * typed failure, so the caller shows the source instead of a broken diagram.
 */
export const renderDiagram = async ({
  id,
  source,
  fonts,
  loadEngine = loadPele,
}: RenderDiagramArgs): Promise<DiagramRender> => {
  const engine = await Result.tryPromise({
    try: async () => {
      const pele = await loadEngine();
      return { pele, loaded: await pele.load(pele.detectType(source)) };
    },
    catch: (cause) =>
      new DiagramRenderFailure({
        reason: "engine-unavailable",
        message: "The diagram engine could not be loaded.",
        cause,
      }),
  });
  if (Result.isError(engine)) {
    return Result.err(engine.error);
  }
  const { pele, loaded } = engine.value;
  if (!loaded) {
    return Result.err(
      new DiagramRenderFailure({
        reason: "unsupported-diagram",
        message: "The diagram type is not supported.",
      }),
    );
  }
  return Result.try({
    try: () => ({
      svg: pele.render(source, { ...PELE_OPTIONS, ...fonts, idPrefix: id }).svg,
    }),
    catch: (cause) =>
      new DiagramRenderFailure({
        reason: cause instanceof pele.PeleError ? cause.code : "syntax",
        message:
          cause instanceof Error
            ? cause.message
            : "The diagram could not be rendered.",
        cause,
      }),
  });
};

export const documentFonts = async (): Promise<DiagramFonts> => {
  await document.fonts.ready;
  return {
    fontFamily: getComputedStyle(document.body).fontFamily,
    fontFamilyMono: getComputedStyle(document.documentElement)
      .getPropertyValue("--font-mono")
      .trim(),
  };
};
