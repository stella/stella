// Passive regression fixture for
// docs-source-policy/docs-source-policy.
//
// The real rule aggregates package manifests when it visits the canonical
// documentation policy. This fixture proves Oxlint still loads and executes
// that repository-level listener.

// oxlint-disable-next-line docs-source-policy/docs-source-policy -- The fixture intentionally proves the repository policy listener executes.
export const fixture = "docs-source-policy";
