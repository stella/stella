/**
 * Catalogue over the committed fixture content. Consumers that need a
 * populated catalogue in tests bind this instead of the bundled one, so their
 * assertions do not depend on whether the content submodule is checked out.
 */

import path from "node:path";

import {
  createTemplatePackCatalogue,
  type TemplatePackCatalogue,
} from "../catalogue";
import type { GeneratedTemplatePack } from "../schema";
import { GENERATED_TEMPLATE_PACKS } from "./packs.gen";

export const FIXTURE_TEMPLATE_PACKS = GENERATED_TEMPLATE_PACKS;

export const fixtureTemplatePackContentRoot = (): string =>
  path.join(import.meta.dir, "content");

export const createFixtureTemplatePackCatalogue = (
  packs: readonly GeneratedTemplatePack[] = GENERATED_TEMPLATE_PACKS,
): TemplatePackCatalogue =>
  createTemplatePackCatalogue({
    packs,
    contentRoot: fixtureTemplatePackContentRoot(),
  });
