// Keys for the component-assembled product previews. A product (or section)
// references a preview by key in its data; ProductPreview maps the key to a live
// mock UI rendered from components + tokens — there are no screenshots to keep in
// sync. New preview = add a key here + a case in ProductPreview (exhaustive).
//
// These live in the landing for now; the intent is to lift this module into a
// shared @stll/previews package the app can also consume.
export type ProductPreviewKey = "review-grid";
