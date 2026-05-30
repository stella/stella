/**
 * Default feature-module registry.
 *
 * To add a new OOXML renderer:
 *   1. Create `modules/<kind>.ts` exporting a `FeatureModule<"...">`.
 *   2. Add one import + `register(...)` line below.
 *
 * Discovery is explicit (not glob-based) so register lines are greppable
 * and tree-shaking stays deterministic.
 */

import { imageModule } from "./modules/image";
import { paragraphModule } from "./modules/paragraph";
import { tableModule } from "./modules/table";
import { textBoxModule } from "./modules/textBox";
import { createFeatureRegistry } from "./registry";
import type { FeatureRegistry } from "./registry";

export function createDefaultRegistry(): FeatureRegistry {
  const registry = createFeatureRegistry();
  registry.register(paragraphModule);
  registry.register(tableModule);
  registry.register(imageModule);
  registry.register(textBoxModule);
  return registry;
}
