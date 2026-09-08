/**
 * The manifest, derived from the document.
 *
 * The DOCX is the template: a value marker's filter chain and a `{% for %}`
 * opener's are the whole field configuration, so the manifest is a cache of
 * reading them, never a store beside them. It is computed here and nowhere
 * else, so every write path (create, save, configure) leaves `templates.manifest`
 * saying exactly what the stored bytes say.
 *
 * The cache exists for the read paths: the fill form, the prefill targets and
 * the agent's read-back all want the field list without re-parsing a DOCX out
 * of object storage on every request.
 */

import { discoverTemplate } from "./discover-template";
import {
  manifestFieldsFromMerge,
  mergeManifestWithDiscovery,
} from "./template-manifest";
import type { DiscoveredTemplate, TemplateManifest } from "./types";

/** The manifest shape this build derives. One number, because a derived cache
 *  has no history to migrate: an older one is recomputed, not upgraded. */
const MANIFEST_VERSION = 1;

/**
 * The manifest this document declares. The marker filters are the fields;
 * discovery's structure (a field's kind, how many times it occurs, the items
 * a repeat holds, the condition that gates it) merges onto them, and the
 * renderings a lookup owns are folded away, so what comes back is the field
 * list the fill form asks and the agent reads.
 */
export const deriveManifest = (
  discovered: DiscoveredTemplate,
): TemplateManifest => {
  const declared: TemplateManifest = {
    version: MANIFEST_VERSION,
    fields: [...discovered.documentFields],
  };
  return {
    version: MANIFEST_VERSION,
    fields: manifestFieldsFromMerge(
      mergeManifestWithDiscovery(declared, discovered),
      declared,
    ),
  };
};

/** The manifest these bytes declare. */
export const deriveManifestFromDocx = async (
  docxBuffer: Buffer,
): Promise<TemplateManifest> =>
  deriveManifest(await discoverTemplate(docxBuffer));
