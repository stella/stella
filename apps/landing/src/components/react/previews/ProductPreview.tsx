import type { ComponentType } from "react";

import type { SceneWindowId } from "../../../data/product-story";
import { AgentAnswerPreview } from "./AgentAnswerPreview";
import { AnonymizationPreview } from "./AnonymizationPreview";
import { CaseLawReaderPreview } from "./CaseLawReaderPreview";
import { CliMcpPreview } from "./CliMcpPreview";
import type { ProductPreviewKey } from "./keys";
import { RegistryLookupPreview } from "./RegistryLookupPreview";
import { TemplateEditorPreview } from "./TemplateEditorPreview";
import { WorkspacePreview } from "./WorkspacePreview";

// Props every preview is handed. Only the scene previews read `windowLabels`
// (their window handles need accessible names); the rest declare no props at
// all and structurally ignore it, which is why one prop type covers the map.
type PreviewProps = { windowLabels: Record<SceneWindowId, string> };

// Key -> live preview component. A Record (not a switch) makes it exhaustive: a
// new ProductPreviewKey fails typecheck until it is wired here. Rendered by Astro
// without a client directive — static HTML with pure-CSS animation, no JS shipped.
const PREVIEWS: Record<ProductPreviewKey, ComponentType<PreviewProps>> = {
  "case-law-reader": CaseLawReaderPreview,
  "cli-mcp": CliMcpPreview,
  "cli-mcp-template": ({ windowLabels }) => (
    <CliMcpPreview initialScenarioId="template" windowLabels={windowLabels} />
  ),
  anonymization: AnonymizationPreview,
  "agent-answer": AgentAnswerPreview,
  "registry-lookup": RegistryLookupPreview,
  "template-editor": TemplateEditorPreview,
  workspace: WorkspacePreview,
};

export const ProductPreview = ({
  previewKey,
  windowLabels,
}: PreviewProps & { previewKey: ProductPreviewKey }) => {
  const Preview = PREVIEWS[previewKey];
  return <Preview windowLabels={windowLabels} />;
};
