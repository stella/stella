/**
 * settings.xml parser
 *
 * Extracts document-wide settings the layout pipeline consumes at render
 * time. We deliberately read only the handful of settings that affect
 * layout; the rest of settings.xml (compatibility flags, view state,
 * autoformat options) is preserved opaquely by the rezip step and ignored
 * here.
 *
 * See ECMA-376 §17.15 for the full settings part.
 */

import type { DocumentSettings } from "../types/document";
import { findChild, getAttribute, parseXmlDocument } from "./xmlParser";
import type { XmlElement } from "./xmlParser";

export type { DocumentSettings };

/** OOXML default per §17.6.13 when `w:defaultTabStop` is absent. */
export const DEFAULT_TAB_STOP_TWIPS = 720;

/**
 * Sanity cap on `w:defaultTabStop`. Word's maximum margin is ~22 inches
 * (31 680 twips); anything past that is corruption or a hostile input and
 * we substitute the OOXML default instead.
 */
const MAX_TAB_STOP_TWIPS = 31_680;

export function parseSettings(xml: string | null): DocumentSettings {
  const root = xml ? (parseXmlDocument(xml) as XmlElement | null) : null;
  return {
    defaultTabStop: parseDefaultTabStop(root),
  };
}

function parseDefaultTabStop(root: XmlElement | null): number {
  if (!root) {
    return DEFAULT_TAB_STOP_TWIPS;
  }
  const el = findChild(root, "w", "defaultTabStop");
  if (!el) {
    return DEFAULT_TAB_STOP_TWIPS;
  }
  const raw = getAttribute(el, "w", "val");
  if (raw === null) {
    return DEFAULT_TAB_STOP_TWIPS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_TAB_STOP_TWIPS) {
    return DEFAULT_TAB_STOP_TWIPS;
  }
  return parsed;
}
