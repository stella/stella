/**
 * Common OOXML namespace URIs.
 *
 * Canonical source for namespace constants shared across
 * the editor (folio) and the backend (api).
 */

export const OOXML_NS = {
  // Main namespaces
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",

  // Drawing namespaces
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  wp14: "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing",
  wps: "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
  wpc: "http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas",
  wpg: "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",

  // Picture namespace
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",

  // Math namespace
  m: "http://schemas.openxmlformats.org/officeDocument/2006/math",

  // Markup Compatibility
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",

  // Legacy VML
  v: "urn:schemas-microsoft-com:vml",
  o: "urn:schemas-microsoft-com:office:office",

  // Other
  w14: "http://schemas.microsoft.com/office/word/2010/wordml",
  w15: "http://schemas.microsoft.com/office/word/2012/wordml",

  // Content Types
  ct: "http://schemas.openxmlformats.org/package/2006/content-types",

  // Relationships
  pr: "http://schemas.openxmlformats.org/package/2006/relationships",
} as const;

export type OoxmlPrefix = keyof typeof OOXML_NS;
