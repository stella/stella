import type { ComponentType } from "react";

import { AgentAnswerPreview } from "./AgentAnswerPreview";
import { AnonymizationPreview } from "./AnonymizationPreview";
import { CaseLawReaderPreview } from "./CaseLawReaderPreview";
import { CliMcpPreview } from "./CliMcpPreview";
import type { ProductPreviewKey } from "./keys";
import { RegistryLookupPreview } from "./RegistryLookupPreview";
import { TemplateEditorPreview } from "./TemplateEditorPreview";
import { WorkspacePreview } from "./WorkspacePreview";

// Key -> live preview component. A Record (not a switch) makes it exhaustive: a
// new ProductPreviewKey fails typecheck until it is wired here. Rendered by Astro
// without a client directive — static HTML with pure-CSS animation, no JS shipped.
const PREVIEWS: Record<ProductPreviewKey, ComponentType> = {
  "case-law-reader": CaseLawReaderPreview,
  "cli-mcp": CliMcpPreview,
  "cli-mcp-template": () => <CliMcpPreview initialScenarioId="template" />,
  anonymization: AnonymizationPreview,
  "agent-answer": AgentAnswerPreview,
  "registry-lookup": RegistryLookupPreview,
  "template-editor": TemplateEditorPreview,
  workspace: WorkspacePreview,
};

export const ProductPreview = ({
  previewKey,
}: {
  previewKey: ProductPreviewKey;
}) => {
  const Preview = PREVIEWS[previewKey];
  return <Preview />;
};
