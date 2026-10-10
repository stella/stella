# @stll/decision-reader

Shared decision and document-AST rendering for Stella hosts. The package owns
the text markup, reader styles, outlines, text scaling, and inline marks.
Hosts own routing, queries, authentication, annotations, inspector panels,
notifications, and analytics.

## Render a decision

Wrap the reader in `DecisionReaderProvider` from
`@stll/decision-reader/reader-adapters`. Its required adapters supply typed
messages and host presentation actions. `ReaderPresentationProvider` supplies
the smaller message and permalink contract for document-AST rendering outside
a decision reader. A missing provider is an invariant failure.

Resolve decision data and citation/provision anchors in the host. Call the pure
`prepareDecisionTextPlacements` from `@stll/decision-reader/decision-text`
with the visible blocks, resolved anchors, annotation anchors, and link-rendering
adapters. Pass its returned `placements` to `DecisionText` together with the
decision and decision ID. The placement result includes failures so the host
can report them through its own telemetry.

The package performs no fetching and mounts no React effects. Supply hydration
state through `isHydrated`; its default is false for server rendering. Hosts
attach any scrolling or landing lifecycle through the reader's `articleRef`.

`useReaderTextScale` accepts optional structural storage and analytics adapters.
Supply storage after hydration to preserve initial markup parity. Without
storage, the reader uses its default scale. Rejected writes keep the selected
size on screen and report to the optional analytics adapter.

## Imports and styles

Import explicit subpaths; there is no package-root barrel. Main entry points:

- `decision-text`, `decision-text.logic`, and `reader-types` for decisions.
- `reader-adapters` for providers and typed host contracts.
- `document-ast-text` for AST blocks and inline rendering.
- `reader-outline`, `reader-search`, and `query-marks` for reader utilities.
- `use-reader-text-scale` and `reader-text-scale.logic` for text size.
- `annotation-anchors`, `citation-link`, `citation-treatment`,
  `provision-anchors`, and `fallback-legal-anchors` for marks and links.
- `source-link-policy`, `reader-inset-box`, and `reader-landing` for shared
  presentation and host-driven landing behavior.

The renderer imports `reader.css`; hosts may also import
`@stll/decision-reader/reader.css` explicitly. Tailwind hosts must scan this
package's `src/**/*.{ts,tsx}` alongside the shared UI sources. The stylesheet
uses Stella theme tokens and includes the existing Source Serif font.

`packages/scripts/src/decision-reader-boundary.test.ts` guards production
dependencies, imports, lifecycle boundaries, and shared renderer ownership.
