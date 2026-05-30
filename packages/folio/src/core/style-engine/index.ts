/**
 * Style Engine — explicit cached OOXML style cascade.
 *
 * See {@link createStyleEngine} for the public entry point.
 */

export {
  createStyleEngine,
  type StyleEngine,
  type StyleEngineCacheStats,
  type StyleEngineOptions,
} from "./styleEngine";
export type { ResolvedParagraphStyle } from "../prosemirror/styles/styleResolver";
