// Keys for the component-assembled product previews. A product (or section)
// references a preview by key in its data; ProductPreview maps the key to a live
// storyboard rendered from components, tokens, and source-controlled product
// captures. New preview = add a key here + a case in ProductPreview (exhaustive).
//
// These are token-adaptive lookalikes modeled on the app UI.
export type ProductPreviewKey =
  | "case-law-reader"
  | "cli-mcp"
  | "cli-mcp-template"
  | "anonymization"
  | "agent-answer"
  | "registry-lookup"
  | "template-editor"
  | "workspace";
