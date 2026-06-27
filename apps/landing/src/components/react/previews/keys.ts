// Keys for the component-assembled product previews. A product (or section)
// references a preview by key in its data; ProductPreview maps the key to a live
// mock UI rendered from components + tokens — there are no screenshots to keep in
// sync. New preview = add a key here + a case in ProductPreview (exhaustive).
//
// review-grid renders the real app FieldValue/skeleton via @stll/workspace-ui
// (drift-proof). The rest are token-adaptive lookalikes modeled on the app UI.
export type ProductPreviewKey =
  | "review-grid"
  | "case-law-reader"
  | "anonymization"
  | "agent-answer"
  | "template-editor"
  | "workspace";
