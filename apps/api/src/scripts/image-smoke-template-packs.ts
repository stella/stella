import { panic, Result } from "better-result";

import { createBundledTemplatePackCatalogue } from "@stll/template-packs";

const REQUIRED_PUBLIC_PACK = "general-legal";

/** Validate the runner's content through the same loader used by the API. */
export const checkBundledPublicTemplates = async (
  contentRoot: string | undefined,
): Promise<void> => {
  if (!contentRoot) {
    panic("TEMPLATE_PACKS_CONTENT_DIR must be set for the image smoke");
  }
  const catalogue = createBundledTemplatePackCatalogue(contentRoot);
  const pack = catalogue.get(REQUIRED_PUBLIC_PACK);
  if (!pack?.publicDisplay || pack.templates.length === 0) {
    panic("bundled public template catalogue is incomplete");
  }
  const reads = await Promise.all(
    pack.templates.map(
      async ({ slug }) =>
        await catalogue.readTemplateDocx({ packId: pack.id, slug }),
    ),
  );
  for (const read of reads) {
    if (Result.isError(read)) {
      panic(read.error.message);
    }
  }
};
