import type {
  PlaybooksActions,
  PlaybooksSource,
} from "@/features/knowledge/views/playbooks/playbooks-seam";
import type {
  TemplatesActions,
  TemplatesSource,
} from "@/features/knowledge/views/templates/templates-seam";

/**
 * The seam between the shared Knowledge views and their data. A view renders
 * a section's source and calls its actions; the route picks the adapter that
 * supplies both, so a view never reaches a data module itself.
 */
type KnowledgeSourceBySection = {
  templates: TemplatesSource;
  playbooks: PlaybooksSource;
};

type KnowledgeActionsBySection = {
  templates: TemplatesActions;
  playbooks: PlaybooksActions;
};

type KnowledgeSection = keyof KnowledgeSourceBySection;

export type KnowledgeSource<Section extends KnowledgeSection> =
  KnowledgeSourceBySection[Section];

export type KnowledgeActions<Section extends KnowledgeSection> =
  KnowledgeActionsBySection[Section];
