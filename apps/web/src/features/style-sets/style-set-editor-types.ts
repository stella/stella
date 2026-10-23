import type { api } from "@/lib/api";

type StellaStyleEditorResponse = Awaited<
  ReturnType<(typeof api)["style-sets"]["editor"]["stella"]["get"]>
>;
type StellaStyleEditorData = Exclude<
  NonNullable<Extract<StellaStyleEditorResponse, { data: unknown }>["data"]>,
  Response
>;

export type StyleSetEditorSettings = StellaStyleEditorData["settings"];

export type StyleSetEditorTarget =
  | { type: "stella" }
  | { type: "saved"; styleSetId: string };

export type ParagraphStyleSettings = StyleSetEditorSettings["title"];
export type NumberedParagraphStyleSettings = StyleSetEditorSettings["level1"];
