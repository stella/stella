# Stella oxlint plugins

These plugins enforce Stella-specific invariants that TypeScript and general-purpose
lint rules cannot express. Each rule source documents its detection boundary with
flagged and accepted examples; each module has a regression fixture in
[`__fixtures__`](./__fixtures__).

The root [`oxlint.config.ts`](../oxlint.config.ts) registers every module and enables
every exported rule in its intended scope. `bun scripts/check-oxlint-plugin-registry.ts`
keeps the module name, exported rule IDs, production config, fixtures, catalogue, and
local links in sync. `bash scripts/lint-oxlint-fixtures.sh` proves the positive cases:
if a detector stops reporting, its intentionally suppressed fixture becomes an unused
directive and CI fails.

"Import X only from its owner module" rules share one table and detector in
[`restricted-import.ts`](./restricted-import.ts): each row names the modules, the
restricted exports (or the whole module), the owner files, and the message. The
plugin files named after each rule are entry points that keep rule IDs stable; add a
row there instead of writing a new import detector.

## Automatic fixes

`oxlint --fix` repairs violations only when the rule can derive one local,
deterministic result without choosing a domain value, dependency, or control-flow
contract:

- `no-physical-properties` maps physical Tailwind directions in direct JSX
  `className` values, including logical corner radii and scroll spacing.
- `no-layout-motion-classes` rewrites the `screen` viewport utilities to their
  `dvh`/`dvw` equivalents in provable class strings. `transition-all` has no
  safe automatic replacement because the intended property is ambiguous.
- `no-awaited-builder-union` moves `await` into the leaves of a directly wrapped
  conditional.
- `no-coerced-optional-union-enum` expands inline string values in a namespaced
  `t.Optional(t.UnionEnum(...))` call.

Context-dependent forms remain diagnostics. `scripts/oxlint-safe-fixers.test.ts`
runs the real CLI twice per repair, checks the exact output, and proves each fixer
reaches a fixed point. It also checks representative ambiguous forms remain
unchanged for a human or coding agent to resolve.

## How to read the catalogue

The text below is a concise contract, not a claim that syntax analysis proves more
than it does. A rule can prove only the shapes described in its source. Security rules
that recognize local data flow say so explicitly; they do not replace authorization,
runtime validation, or integration tests.

### Security, identity, files, and external boundaries

- [`auth-lifecycle`](./auth-lifecycle.ts) (`after-remove-member-revokes-artifacts`, `no-direct-auth-artifact-delete`): keeps authentication-artifact deletion behind the lifecycle that revokes all member-owned credentials; tables and the helper resolve by import, and a helper call in unreachable code does not count.
- [`mcp-security`](./mcp-security.ts) (`redact-oauth-registration-response`, `no-direct-oauth-client-join`): redacts OAuth registration secrets and confines OAuth client joins to the authorized MCP boundary.
- [`no-auth-token-in-web-storage`](./no-auth-token-in-web-storage.ts) (`no-auth-token-in-web-storage`): rejects credential-like keys (literal, `const`, or imported) and serialized credential fields written to browser storage, directly or through a local forwarding helper; authentication secrets belong in server-set secure cookies.
- [`no-body-ownership-ids`](./no-body-ownership-ids.ts) (`no-body-ownership-ids`): prevents request bodies and query strings from supplying trusted workspace or organization ownership IDs.
- [`no-hand-rolled-user-identity`](./no-hand-rolled-user-identity.ts) (`no-hand-rolled-user-identity`): requires canonical user-display helpers instead of rebuilding names and initials at call sites.
- [`no-object-url-leak`](./no-object-url-leak.ts) (`no-object-url-leak`): follows locally owned `URL.createObjectURL` values and requires matching revocation.
- [`no-path-prefix-containment`](./no-path-prefix-containment.ts) (`no-path-prefix-containment`): rejects filesystem containment checks based on a bare string prefix, which also accepts sibling paths.
- [`no-raw-api-url`](./no-raw-api-url.ts) (`no-direct-api-env`, `no-raw-api-url`): confines the browser and external API bases to one resolver and rejects hand-written API request paths, preventing same-origin routing from drifting back to direct cross-origin calls.
- [`failure-sink-handle`](./failure-sink-handle.ts) (`failure-sink-handle`): requires `observeFailure`'s `sink` to be a handle passed by name, created once by `failureSink(...)` at module scope, so every site's failure policy is a reviewed declaration.
- [`no-raw-error-logging`](./no-raw-error-logging.ts) (`no-raw-error-logging`): keeps raw messages, stacks, causes, and stringified errors out of production logs and process streams (including `Bun.write` to `Bun.stderr`/`Bun.stdout`), and the raw `error.msg` key out of production code outside the legacy field helpers.
- [`no-redacted-log-attribute-key`](./no-redacted-log-attribute-key.ts) (`no-redacted-log-attribute-key`): rejects a static attribute key in a `logger.*` call that matches the logger's sensitive-key denylist, because the sanitizer would drop it and the record would ship without it, and an `observeFailure` context key outside the reviewed `FAILURE_CONTEXT_KEYS`. Computed keys and spreads are out of scope; the denylist and context-key copies are held equal to their owners by a guardrails test.
- [`no-raw-resource-uri`](./no-raw-resource-uri.ts) (`no-raw-resource-uri`, `require-rfc3986-resource-encoding`): centralizes resource URI construction and requires RFC 3986 encoding where path segments are composed.
- [`no-raw-user-avatar-primitive`](./no-raw-user-avatar-primitive.ts) (`no-raw-user-avatar-primitive`): requires the owned avatar primitive so identity fallback and accessibility behavior remain consistent.
- [`no-raw-user-id-schema`](./no-raw-user-id-schema.ts) (`no-raw-user-id-schema`): prevents plain string schemas from laundering user IDs across trust boundaries.
- [`no-secret-in-log-sink`](./no-secret-in-log-sink.ts) (`no-secret-in-log-sink`): traces credential-named values (case-insensitive word match), secret `process.env` / `Bun.env` reads, and their local aliases into console and logger methods, Sentry, span attributes, analytics `capture`, Error constructors with or without `new`, and `JSON.stringify`; masking helpers count only when imported from their owning module.
- [`no-unbranded-ownership-id-param`](./no-unbranded-ownership-id-param.ts) (`no-unbranded-ownership-id-param`): requires validated workspace and organization IDs to retain their branded type through API parameters.
- [`no-unbounded-response-body`](./no-unbounded-response-body.ts) (`no-unbounded-response-body`): rejects `.arrayBuffer()`, `.text()`, `.json()`, `.blob()`, and `.bytes()` on a fetch `Response` in `apps/api/src`, plus the unbounded object-storage readers of `@/api/lib/s3` and AWS SDK `Body` materialisation; bodies are read through `safeOutboundFetchBytes`/`safeOutboundFetchStream`, `readCappedBytes`, or `readS3ObjectBounded`/`readCorpusS3ObjectBounded`. A receiver is a Response only by visible provenance (a `fetch`/`<x>.fetch`/`fetchWithTimeout`/`fetchPublisher`/`fetchWithRetry` call, a same-file function or binding annotated `Response`, through `await`, `.clone()`, stable bindings, and `Promise.all` destructuring); requests, uploads, and local files are never reported. Debt is carried per file in `scripts/design-lint-baseline.json`.
- [`no-unjustified-double-assertion`](./no-unjustified-double-assertion.ts) (`no-unjustified-double-assertion`): requires a nearby `SAFETY:` explanation when a direct TypeScript assertion chain widens through `unknown`, `object`, or an open record before asserting a narrower contract.
- [`no-unowned-file-version-write`](./no-unowned-file-version-write.ts) (`no-unowned-file-version-write`): prevents file-version writes that are not tied to an authorized owning workspace or document.
- [`no-unsafe-inner-html`](./no-unsafe-inner-html.ts) (`no-unsafe-inner-html`): covers `dangerouslySetInnerHTML` (JSX or props objects), `innerHTML` / `outerHTML` / `srcdoc`, `insertAdjacentHTML`, `setHTMLUnsafe`, `createContextualFragment`, and `document.write`; static markup passes, dynamic HTML requires a `safe-html: <provenance>` comment directly above the one sink it covers, because sanitizer-looking function names are not proof.
- [`no-unvalidated-json-domain-cast`](./no-unvalidated-json-domain-cast.ts) (`no-unvalidated-json-domain-cast`): rejects assertions that turn unvalidated `response.json()` or `JSON.parse()` output into closed domain types.
- [`public-case-law-db-boundary`](./public-case-law-db-boundary.ts) (`public-case-law-db-boundary`): confines public case-law database access to its explicit read-only boundary (schema imports, `tx.query`, private SQL text) in every API file that imports `@/api/lib/case-law-public-read-db`, and holds every relation a public-law read's SQL names (after FROM or JOIN, in `sql` templates and `sql.raw` strings) to the public-law relation map in every file that imports a public-law read owner; an interpolated relation must be a public schema table or a SQL fragment the file writes.
- [`public-law-read-boundary`](./public-law-read-boundary.ts) (`require-language-alternate-counts`, `require-configured-read-transaction`): requires both public case-law search implementations to invoke the shared language-count reader and both public-law database modes to configure their transaction before shared reads run.
- [`require-audit-on-mutation`](./require-audit-on-mutation.ts) (`require-audit-on-mutation`): requires sensitive mutations (drizzle writes on any database handle and raw `execute` writes) to carry their corresponding structured audit action; `// audit: skip - <reason>` needs a three-word reason and is budgeted by the `audit-skip-directives` ratchet.
- [`require-bounded-request-schema`](./require-bounded-request-schema.ts) (`require-bounded-request-schema`): requires every `t.String()` in an API request schema to carry `maxLength` (or a fixed-width `uuid`/`date` format) and every `t.Array()` to carry `maxItems`. Request schemas are the values of `body`/`query`/`params`/`headers` properties that are TypeBox builders or same-file bindings to one, plus module-level consts named `…Body`/`…Query`/`…Params`/`…Headers` (optionally `…Schema`); response and internal schemas are out of scope. Debt is carried per file in `scripts/design-lint-baseline.json`.
- [`require-file-transport-disposition`](./require-file-transport-disposition.ts) (`require-file-transport-disposition`): requires file responses to declare the owned inline or attachment transport disposition.
- [`require-safe-outbound-target`](./require-safe-outbound-target.ts) (`require-safe-outbound-target`): keeps arbitrary outbound URLs behind SSRF-aware fetch helpers unless their origin is statically trusted; recognises the fetch wrappers (and their re-exporting modules), global `fetch`, `undici`, `node:http(s)` `request`/`get`, and `new WebSocket` by binding, and takes no file allowlist: a trusted runtime target is suppressed at its call.
- [`require-safe-route-handlers`](./require-safe-route-handlers.ts) (`require-safe-route-handlers`, `no-direct-handler-config`): requires route handlers to use the safe handler wrappers that establish authentication and error boundaries, and prevents Elysia from mutating the endpoint config object that those wrappers retain.
- [`require-safe-window-open`](./require-safe-window-open.ts) (`require-safe-window-open`): requires isolated, sanitized popup opening instead of direct `window.open` calls.
- [`require-workspace-handler-config`](./require-workspace-handler-config.ts) (`require-workspace-handler-config`): requires a config passed to `createSafeHandler` to be pinned with `satisfies WorkspaceHandlerConfig`, so the params schema is checked against the workspace-scoped type where it is written rather than at the factory call.
- [`require-stream-reader-disposal`](./require-stream-reader-disposal.ts) (`require-stream-reader-disposal`): requires locally owned stream readers to cancel when needed and release their lock in `finally`.
- [`s3-object-boundary`](./s3-object-boundary.ts) (`no-native-s3-object-read`, `no-native-s3-object-write`): confines native S3 object body reads and writes to the owned storage modules. Both rules share one resolver: a client is `getS3()`/`getCorpusS3()` resolved through its import from `@/api/lib/s3` (aliases, namespace imports, and never-reassigned locals included), a Bun `S3Client` construction, or Bun's default `s3` client; a file handle is `.file(key)` on one. Reads keep cancellation, bounds, credentials, and response validation; writes go through `writeS3ObjectWithRetry()` or `putCorpusS3ObjectWithSignal()` so retries converge at one key. `.write()` on a client or handle, `Bun.write(<handle>, ...)`, and `send(new PutObjectCommand(...))` count as writes. Bun 1.4's native reader is covered by an integration smoke, but production reads remain on the cancellable transport until the native API accepts an `AbortSignal`.
- [`security-guards`](./security-guards.ts) (`no-raw-filename-write`, `no-unsanitized-href`, `no-unscoped-user-query`, `require-secure-document-response`): follows request-derived filenames (handler `body`/`params`, uploads, multipart parts, through aliases, destructuring and string methods) into `fileName`/`filename` keys and assignments unless `sanitizeFilename` from its owning module wraps them, requires dynamic anchor URLs to call the imported `sanitizeHref()` at the sink, requires each query chain reading the auth-schema `user` table (resolved by binding) to reference both `member.userId` and `member.organizationId` (a plain insert reads nothing; modules listed in `allowedFiles` carry the reason their scope holds), and enforces secure headers on document responses. These are deliberately narrow syntax guards, not general taint or authorization proofs.

### Database, ingestion, pagination, and data shape

- [`no-bare-jsonb-cast`](./no-bare-jsonb-cast.ts) (`no-bare-jsonb-cast`): rejects bare PostgreSQL JSONB casts that bypass the typed JSONB expression helper.
- [`no-hand-rolled-sql-case`](./no-hand-rolled-sql-case.ts) (`no-hand-rolled-sql-case`): rejects a SQL `CASE` whose branch list is generated in the interpolation, where an empty list renders a branchless `CASE`; the shared renderers return the fallback instead.
- [`no-network-await-in-loop`](./no-network-await-in-loop.ts) (`no-network-await-in-loop`): catches an HTTP request, AWS SDK command dispatch, or API-client method awaited once per loop iteration; network owners are matched by import source, not by identifier spelling.
- [`no-direct-audit-log-insert`](./no-direct-audit-log-insert.ts) (`no-direct-audit-log-insert`): keeps audit-log insertion behind the canonical append-only audit service.
- [`scanned-file-boundary`](./scanned-file-boundary.ts) (`scanned-file-boundary`): rejects casts to `ScannedFile` or `FileKey`, prototype-built `ScannedFile`s, restricted mint imports, and direct folio-core DOCX parser imports or `FolioDocxReviewer.fromBuffer` calls outside their owning modules, so parser inputs are scanned uploads, bytes read back from a file key, case-law publisher downloads, or folio's own output for one of those.
- [`no-raw-zip-load`](./no-raw-zip-load.ts) (`no-raw-zip-load`): rejects `JSZip.loadAsync` outside `lib/docx-archive.ts` and the file scanner, so archive entry reads stay size-capped; existing callers are frozen by the rule's suppression budget.
- [`no-direct-buffer-cleanup-intent-delete`](./no-direct-buffer-cleanup-intent-delete.ts) (`no-direct-buffer-cleanup-intent-delete`): keeps publication-time cleanup-intent retirement behind the transaction-owned reconciliation helper; tests and the owning reconciliation module may delete directly.
- [`no-direct-ingestion-checkpoint-write`](./no-direct-ingestion-checkpoint-write.ts) (`no-direct-ingestion-checkpoint-write`): keeps checkpoint writes behind the replay-safe ingestion coordination helper.
- [`no-literal-decision-court`](./no-literal-decision-court.ts) (`no-literal-decision-court`): rejects a string or template literal written into a case-law adapter's `court`; a publisher is not a court, so the deciding court is resolved from the record's own ECLI and court field through `apps/api/src/lib/case-law/cz-ecli-courts.ts`.
- [`no-raw-decision-text-fields`](./no-raw-decision-text-fields.ts) (`no-raw-decision-text-fields`): enforces the explicit decision-text boundary on adapter payloads, including aliased metadata and dynamic writes.
- [`no-direct-property-table-write`](./no-direct-property-table-write.ts) (`no-direct-property-table-write`): keeps direct `properties` table inserts/updates behind the property handlers and lib modules that own its derived columns (kinds).
- [`no-direct-template-version-write`](./no-direct-template-version-write.ts) (`no-direct-template-version-write`): keeps template-version mutations behind the initial-template creator and existing-template write coordinator that own DOCX publication and cleanup intents.
- [`require-buffer-cleanup-intent-status`](./require-buffer-cleanup-intent-status.ts) (`require-buffer-cleanup-intent-status`): requires a non-undefined `status` on direct object-literal cleanup-intent inserts, including every direct object in an array; variable-built payloads are outside this syntax-only guard.
- [`no-inline-timestamp-cursor-sql`](./no-inline-timestamp-cursor-sql.ts) (`no-inline-timestamp-cursor-sql`): requires shared timestamp-and-ID cursor predicates instead of hand-written comparison SQL.
- [`no-literal-minor-unit-scale`](./no-literal-minor-unit-scale.ts) (`no-literal-minor-unit-scale`): rejects scaling by a literal 100 an operand that parses a number out of text or carries a money-named identifier at any depth, which hard-codes an exponent the currency owns (JPY has none, KWD has three); convert with `toMinorUnits`/`toMajorUnits` from `@stll/money`. Percent arithmetic with no money operand is unaffected, and `packages/money/src/index.ts` is exempt because the markup and proration contracts it owns use 100 as the percent base.
- [`no-naive-timestamp-cast`](./no-naive-timestamp-cast.ts) (`no-naive-timestamp-cast`): rejects timestamp casts that discard or assume timezone semantics.
- [`queue-worker-error-sink`](./queue-worker-error-sink.ts) (`queue-worker-error-sink`): keeps a queue worker's `error` event on the throttled sink, so a Valkey disruption cannot log one line per failed poll.
- [`no-offset-pagination`](./no-offset-pagination.ts) (`no-offset-pagination`): prevents offset/skip pagination in scalable application query paths.
- [`no-spread-input-in-query-key`](./no-spread-input-in-query-key.ts) (`no-spread-input-in-query-key`): prevents whole input objects from silently changing query-key identity as fields evolve.
- [`no-truncated-timestamp-comparison`](./no-truncated-timestamp-comparison.ts) (`no-truncated-timestamp-comparison`): prevents cursor and ordering comparisons against timestamps truncated below stored precision.
- [`no-untyped-updates`](./no-untyped-updates.ts) (`no-untyped-updates`): rejects broad `Record<string, unknown | any>` update bags only when they flow through stable aliases or spreads into direct Drizzle `update(...).set(...)` sinks; unrelated records remain valid.
- [`no-workspace-field-value-drift`](./no-workspace-field-value-drift.ts) (`no-workspace-field-value-drift`, `no-raw-field-value-bidi-text`): keeps workspace field rendering on the canonical value path and requires bidi-safe rendering for raw field text.
- [`require-coordination-key`](./require-coordination-key.ts) (`require-coordination-key`): requires background and ingestion work to declare the stable key used for deduplication and serialization.
- [`require-custom-jsonb-column`](./require-custom-jsonb-column.ts) (`require-custom-jsonb-column`): requires Drizzle JSONB columns to carry their domain type through `$type`.
- [`require-derived-check-enum`](./require-derived-check-enum.ts) (`require-derived-check-enum`): binds database check-enum values to the canonical TypeScript value set instead of duplicating string literals.
- [`require-escape-like`](./require-escape-like.ts) (`require-escape-like`): requires user-controlled SQL `LIKE` input (drizzle operators, `sql` templates, and `+` concatenation) to pass through the shared wildcard escaper from its owning module.
- [`require-pagination-cursor-schema`](./require-pagination-cursor-schema.ts) (`require-pagination-cursor-schema`): a `cursor` property in an API schema must come from `tPaginationCursor()`; any inline `t.String(...)`, bounded or not, is reported. Files that accept a foreign page token are named in `allowedFiles` in `oxlint.config.ts`.
- [`require-query-limit`](./require-query-limit.ts) (`require-query-limit`): rejects potentially unbounded list queries without an explicit limit.
- [`require-search-scope`](./require-search-scope.ts) (`require-search-scope`): requires search queries to carry their workspace or public-data scope.
- [`require-timestamp-id-cursor-codec`](./require-timestamp-id-cursor-codec.ts) (`require-timestamp-id-cursor-codec`): requires the shared lossless codec for timestamp-and-ID cursors.
- [`require-timestamptz-column`](./require-timestamptz-column.ts) (`require-timestamptz-column`): requires timezone-aware PostgreSQL timestamp columns for instants.
- [`require-transaction-abort`](./require-transaction-abort.ts) (`require-transaction-abort`): requires expected transaction failures to abort the transaction rather than return a partially committed result.

### React, routing, query state, and performance

- [`no-beforeload-redirect`](./no-beforeload-redirect.ts) (`no-beforeload-redirect`): rejects unconditional redirects from `beforeLoad` or `loader`; redirect-only routes must mount a navigation component so abandoned pending trees cannot leak.
- [`no-centered-scroll-column`](./no-centered-scroll-column.ts) (`no-centered-scroll-column`): keeps the scrollbar on the full content pane instead of a centered, width-capped inner column.
- [`no-detached-void`](./no-detached-void.ts) (`no-detached-void`): prevents `void promise` from hiding rejection ownership; use `await`, return the promise, or the monitored `detached()` helper.
- [`no-dialog-trigger-menu-item`](./no-dialog-trigger-menu-item.ts) (`no-dialog-trigger-menu-item`): rejects a dialog trigger mounted inside a menu item, which forces the menu to stay open under the dialog; lift the dialog beside the menu with `open` state instead.
- [`no-disabled-tooltip-trigger`](./no-disabled-tooltip-trigger.ts) (`no-disabled-tooltip-trigger`): rejects tooltip triggers rendered as disabled buttons that cannot receive hover or focus events.
- [`no-duplicate-jsx-sibling-key`](./no-duplicate-jsx-sibling-key.ts) (`no-duplicate-jsx-sibling-key`): rejects equal explicit keys on direct JSX siblings, covering the static-child reconciliation gap left by `react/jsx-key`.
- [`no-inline-endpoint-in-routes`](./no-inline-endpoint-in-routes.ts) (`no-inline-endpoint-in-routes`): requires route code to use owned API clients instead of declaring endpoints inline.
- [`no-optional-mutation-command`](./no-optional-mutation-command.ts) (`no-optional-mutation-command`): rejects React Query mutation commands with multiple optional domain fields; use a discriminated union so empty, conflicting, and semantically ambiguous operations are unrepresentable.
- [`no-inline-style-colors`](./no-inline-style-colors.ts) (`no-inline-style-colors`): rejects hardcoded color values only inside JSX `style={{ ... }}` objects; domain data objects are out of scope.
- [`no-input-dir-auto`](./no-input-dir-auto.ts) (`no-input-dir-auto`): prevents `dir="auto"` on form inputs where direction changes can destabilize layout and value editing.
- [`no-legacy-entity-route`](./no-legacy-entity-route.ts) (`no-legacy-entity-route`): prevents construction of the removed public entity detail route.
- [`no-omitted-prop-respread`](./no-omitted-prop-respread.ts) (`no-omitted-prop-respread`): requires a prop a component omits from its props type to be pinned after the last props spread, because width subtyping keeps the key on the spread value at runtime. It reads literal `Omit` keys and the component's own props binding only.
- [`no-raw-route-query-client`](./no-raw-route-query-client.ts) (`no-raw-route-query-client`): requires route freshness wrappers in loaders and synchronous cache reads in pending components.
- [`no-raw-router-invalidation`](./no-raw-router-invalidation.ts) (`no-raw-router-invalidation`): confines navigation-grade `router.invalidate()` calls to the owned session, locale, and exhaustively classified route-metadata boundaries.
- [`no-raw-stored-json`](./no-raw-stored-json.ts) (`no-raw-stored-json`): requires persisted browser JSON to be parsed and schema-validated through `readStoredJson()`.
- [`no-direct-unsaved-work-guard`](./no-direct-unsaved-work-guard.ts) (`no-direct-unsaved-work-guard`): confines TanStack route blockers and `beforeunload` handlers in `apps/web/src` to `useUnsavedWork`, which also registers the work so the stale-client refresh does not reload over it.
- [`no-raw-use-effect`](./no-raw-use-effect.ts) (`no-raw-use-effect`): bans direct React `useEffect`; use the sanctioned lifecycle wrappers or a more precise primitive.
- [`no-ref-mirror`](./no-ref-mirror.ts) (`no-ref-mirror`): rejects mirroring render values into refs during render, a stale-value and React Compiler hazard.
- [`no-shared-suspense-query`](./no-shared-suspense-query.ts) (`no-shared-suspense-query`): prevents suspense queries in shared UI components that lack route-owned prefetching.
- [`no-static-catalogue-route-import`](./no-static-catalogue-route-import.ts) (`no-static-catalogue-route-import`): prevents static imports of large catalogue route modules that defeat route-level code splitting.
- [`no-strict-route-read-in-chrome`](./no-strict-route-read-in-chrome.ts) (`no-strict-route-read-in-chrome`): prevents strict router reads in reusable chrome that can render outside the matching route.
- [`require-cn-for-classname-composition`](./require-cn-for-classname-composition.ts) (`require-cn-for-classname-composition`): requires conditional, interpolated, concatenated, or helper-composed JSX class names to use `cn` from `@stll/ui/utils`; static and pass-through values remain valid.
- [`require-contained-handler`](./require-contained-handler.ts) (`require-contained-handler`, `no-portal-under-interactive-ancestor`): wraps handlers on ref-owned containers and rejects portaled popups under interactive ancestors so portal-bubbled events cannot trigger unrelated parent behavior or navigation.
- [`require-loader-prefetch`](./require-loader-prefetch.ts) (`require-loader-prefetch`): requires suspense query data to start in the route loader rather than after component mount.
- [`require-query-key-factory`](./require-query-key-factory.ts) (`require-query-key-factory`): requires query keys to come from their feature-owned factory.
- [`require-query-options-key`](./require-query-options-key.ts) (`require-query-options-key`): requires exact cache reads and writes to use options-derived keys and inferred data types; follows local const aliases and permits structurally tagged helper parameters. Prefix filters remain key-factory based.
- [`require-query-signal`](./require-query-signal.ts) (`require-query-signal`): requires query functions to pass TanStack Query's abort signal into fetch or Eden calls.
- [`require-schema-form-options`](./require-schema-form-options.ts) (`require-schema-form-options`): requires production web forms to consume `schemaFormOptions` directly; the helper owns dynamic validation and requires an explicit schema-output versus raw submission choice. Resolves imported factory/helper aliases and namespace access; rejects option spreads and alternate form factories.
- [`require-router-select`](./require-router-select.ts) (`require-router-select`): requires route subscriptions to select only the state a component consumes.
- [`require-stable-editor-options`](./require-stable-editor-options.ts) (`require-stable-editor-options`): requires identity-stable non-handler option values in `useEditor` calls, so the react binding never re-applies editor view props on every render.
- [`require-stable-snapshot`](./require-stable-snapshot.ts) (`require-stable-snapshot`): rejects `useSyncExternalStore` snapshots that allocate a new reference on every read.
- [`require-use-shallow`](./require-use-shallow.ts) (`require-use-shallow`): requires shallow comparison when Zustand selectors return fresh objects or arrays.

### Internationalization, accessibility, and design-system consistency

- [`dialog-footer-owns-actions`](./dialog-footer-owns-actions.ts) (`dialog-footer-owns-actions`): rejects a hand-rolled `div`/`footer`/`section` action row inside a dialog, alert-dialog, or sheet popup; only `DialogFooter` and its siblings paint the full-bleed band with its border and narrow-viewport stacking. Footer, `Field`, and list-rendered buttons are exempt, and only the innermost row is reported.
- [`field-parts-inside-field`](./field-parts-inside-field.ts) (`field-parts-inside-field`): rejects an `@stll/ui/field` part (`FieldLabel`, `FieldDescription`, `FieldError`, `FieldItem`, `FieldValidity`, `FieldControl`) mounted in markup that holds no `Field` above it; Base UI throws while rendering when the root context is missing, and `FieldControl`, which reads it optionally, renders bound to nothing. Resolution is single-file: the lexical walk covers a part's own markup and then where this file mounts the component holding it, so a part held in a variable, handed to a prop, or rendered under a wrapper component from another module is not reported.
- [`icon-button-requires-tooltip`](./icon-button-requires-tooltip.ts) (`icon-button-requires-tooltip`): requires icon-only buttons to expose an accessible label through the owned tooltip contract.
- [`no-decorated-search-input`](./no-decorated-search-input.ts) (`no-decorated-search-input`): rejects a second search icon or a leading `ps-`/`pl-` utility beside an `@stll/ui` `Input`/`InputGroupInput` with `type="search"`, which already draws the icon and reserves its space.
- [`require-in-flow-viewport-popup`](./require-in-flow-viewport-popup.ts) (`require-in-flow-viewport-popup`): requires a Base UI positioner that renders a `Viewport` to size itself and keep its popup in flow through the shared `positioner-sizing` constants, so collision handling measures the real popup on every side.
- [`no-adhoc-loader`](./no-adhoc-loader.ts) (`no-adhoc-loader`): requires the owned `Loader` primitive for indeterminate loading states instead of ad hoc spinners; a ratchet over the files that still carry one.
- [`no-ad-hoc-find-shortcut`](./no-ad-hoc-find-shortcut.ts) (`no-ad-hoc-find-shortcut`): keeps the find shortcut on its single registry listener, so no surface recognises the press itself and reopens the two-bar bug.
- [`no-ambient-hotkey-format`](./no-ambient-hotkey-format.ts) (`no-ambient-hotkey-format`): keeps platform detection and hotkey display formatting behind the hydration-safe helper so server and client output cannot diverge.
- [`no-broad-translation-callable`](./no-broad-translation-callable.ts) (`no-broad-translation-callable`): prevents helpers from carrying the full `TranslationKey` callable, which is both too broad and expensive to type-check.
- [`no-direct-entity-glyph`](./no-direct-entity-glyph.ts) (`no-direct-entity-glyph`): requires the canonical entity glyph mapping rather than local icon choices.
- [`no-direct-matter-glyph`](./no-direct-matter-glyph.ts) (`no-direct-matter-glyph`): requires the canonical matter glyph and affordance mapping.
- [`no-font-utility-in-reader`](./no-font-utility-in-reader.ts) (`no-font-utility-in-reader`): rejects a `font-sans`/`font-serif`/`font-mono` utility, with any variant prefix, in the public-law reader modules. The reader's face is inherited from the reader root, which `reader.css` sets from `--reader-body-font`; a utility on one element mixes two faces in one document. Chrome drawn inside the text takes the named `reader-chrome` class, document text rendered outside the reader root takes `reader-body`. Every class string in those modules is checked, so a utility in a `cn()` argument or a variant map is reported like one written on the element; weights and sizes name no family and stay free.
- [`no-imported-class-constant`](./no-imported-class-constant.ts) (`no-imported-class-constant`): rejects a `className` on a `@stll/ui` component whose value, or whose direct `cn()`/`clsx()` argument, is an identifier imported from another module. `shadcn/no-restyle` judges a class string by reading it, and an import is opaque to it, so the restyle it exists to catch ships unreported. Both the component and the class value resolve through `sourceCode.getScope` and the enclosing scope chain, so a parameter or local that merely reuses an imported spelling is never reported. Same-file constants, intrinsic elements, components from elsewhere, and a forwarded `className` prop stay valid; `packages/ui` composes its own constants and is out of scope. Debt is carried per file in `scripts/design-lint-baseline.json`.
- [`no-layout-motion-classes`](./no-layout-motion-classes.ts) (`no-layout-motion-classes`): guards the motion and viewport conventions over Tailwind class strings. Rejects `transition-all`, a `transition-` utility naming a layout property (`width`, `height`, `top`, `left`, `right`, `bottom`, `inset`, `margin`, `padding`, `flex-basis`, `font-size`), and the `h-screen`/`min-h-screen`/`max-h-screen`/`w-screen` viewport utilities, which resolve against `100vh`/`100vw` and ignore mobile browser chrome. Arbitrary `animate-[…]` values name keyframes rather than properties, so the stylesheet guard checks their declarations. Every class string in scope is checked, including `cn()`/`cva()`/`clsx()` arguments and variant maps; autofix is confined to a direct `className` value or a direct string argument of a class composer. A surface that changes its own box has no compositable spelling, so `allowedFiles` records its exact existing utilities as `{ path, utilities, reason }`; a different layout transition in the same file still fails.
- [`no-legal-cliche-glyph`](./no-legal-cliche-glyph.ts) (`no-legal-cliche-glyph`): bans lucide's scales-of-justice and gavel glyphs (`Scale`, `Gavel`, with their `Icon` and `Lucide` aliases) in reader-facing source; they are the category's stock decoration and say nothing a reader can use. Reported at the import, the JSX element, and a reference passed as a prop, so the replacement is named where it has to be chosen: a court is `LandmarkIcon`, a decision `FileTextIcon`, the case-law section the glyph its sidebar entry already uses. Exact names only, so the `Scale3d` geometry family stays available.
- [`no-physical-properties`](./no-physical-properties.ts) (`no-physical-properties`): rejects physical CSS and Tailwind directions where logical RTL-aware properties exist.
- [`no-raw-date-input`](./no-raw-date-input.ts) (`no-raw-date-input`): requires the owned date-input primitive so locale, timezone, and validation behavior remain consistent.
- [`no-raw-file-input`](./no-raw-file-input.ts) (`no-raw-file-input`): rejects a rendered `<input type="file">` in app and design-system source. Its chrome is untranslatable, and a hidden one repeats the ref, `.click()` and value-reset wiring at every site (a missed reset makes re-picking the same file a silent no-op). `openFilePicker` from `@stll/ui/file-picker` opens the chooser from any handler with no input in the tree; `FileInput` is the labelled single-file field.
- [`no-raw-date-parsing`](./no-raw-date-parsing.ts) (`no-raw-date-parsing`): rejects ambiguous date-only parsing and raw day-length arithmetic that fails across timezones or DST.
- [`prefer-temporal`](./prefer-temporal.ts) (`prefer-temporal`): reserves legacy `Date` construction and serialization for concrete database, protocol, and third-party boundaries; global clock APIs, calendar constructors, and provable Date calendar mutation use explicitly imported Temporal.
- [`no-raw-foreground-opacity`](./no-raw-foreground-opacity.ts) (`no-raw-foreground-opacity`): requires named foreground attenuation tokens instead of unexplained opacity fractions.
- [`no-raw-locale-format`](./no-raw-locale-format.ts) (`no-raw-locale-format`): requires locale-aware shared number and date formatters instead of ambient-locale calls.
- [`no-raw-overflow-scroll`](./no-raw-overflow-scroll.ts) (`no-raw-overflow-scroll`): rejects `overflow-auto`/`overflow-scroll` and their axis forms, under any variant prefix, in `apps/web` and `packages/ui` markup; app chrome scrolls through `ScrollArea`, which owns the scrollbar's width, states, and overlay behaviour. An arbitrary variant targeting `pre`, `table`, or `.ProseMirror` is accepted, and so is every non-scrolling `overflow-*`. Every class string in a scoped file is tokenized, so a utility in a `cn()` argument is read like one on the element. Debt is carried per file in `scripts/design-lint-baseline.json`.
- [`no-raw-public-law-seo`](./no-raw-public-law-seo.ts) (`no-raw-public-law-seo`): centralizes public-law metadata and canonical URL formatting.
- [`no-shadowed-user-name-helpers`](./no-shadowed-user-name-helpers.ts) (`no-shadowed-user-name-helpers`): prevents local bindings from shadowing canonical user-name helpers.
- [`no-unformatted-number`](./no-unformatted-number.ts) (`no-unformatted-number`): requires user-visible numbers to pass through locale-aware formatting.
- [`no-untranslated-jsx-literal`](./no-untranslated-jsx-literal.ts) (`no-untranslated-jsx-literal`): rejects user-facing JSX text that bypasses the translation system.
- [`require-cached-collator`](./require-cached-collator.ts) (`require-cached-collator`): prevents repeated `Intl.Collator` construction in sort and render paths.
- [`require-dir-on-rendered-name`](./require-dir-on-rendered-name.ts) (`require-dir-on-rendered-name`): requires rendered human names to declare direction so mixed-script content remains legible.
- [`require-matter-affordance`](./require-matter-affordance.ts) (`require-matter-affordance`): requires matter labels to use the canonical icon, color, and interaction affordance.
- [`require-relative-time-helpers`](./require-relative-time-helpers.ts) (`require-relative-time-helpers`): centralizes relative-time output in the locale-aware shared helpers.
- [`stella-toast`](./stella-toast.ts) (`stella-toast`): requires the owned toast API so translated copy, deduplication, and error treatment remain consistent.

### Errors, async work, results, and observability

- [`no-async-context-enter-with`](./no-async-context-enter-with.ts) (`no-async-context-enter-with`): bans `AsyncLocalStorage.enterWith`, whose ambient context can leak into unrelated background work; use `run`.
- [`no-bare-error`](./no-bare-error.ts) (`no-bare-error`): requires structured tagged errors or `panic()` instead of unclassified `new Error()` values.
- [`no-minted-auth-provider-id`](./no-minted-auth-provider-id.ts) (`no-minted-auth-provider-id`): bans handing a generated UUID to `toSafeId<"user" | "organization">` or a persisted user/organization brand; those ids come from the auth provider and are not UUIDs.
- [`no-swallowed-rejection`](./no-swallowed-rejection.ts) (`no-swallowed-rejection`, `require-rejection-parameter`): rejects constant empty rejection fallbacks and requires a rejection parameter in locally resolvable `.catch()` / `.then()` handlers; response-body reads and teardown keep their deliberate exemptions. Detection is syntax-based, not type-aware: unrelated APIs with those method names need a narrow explained suppression.
- [`no-unreviewed-typebox-unsafe`](./no-unreviewed-typebox-unsafe.ts) (`no-unreviewed-typebox-unsafe`): rejects TypeBox/Elysia `Unsafe` calls outside exact reviewed adapter bindings; tracks imported aliases and permits local shadowing. Approvals need a nonblank reason and exactly one owned call; the registry check rejects deleted adapter paths.
- [`no-known-value-widening`](./no-known-value-widening.ts) (`no-known-value-widening`): rejects local literal/const erasure to `unknown` or `object`, and open dictionaries later asserted back to a narrower type. Call arguments, parsing results, parameters, and return contracts are outside this same-file analysis.
- [`result-boundary`](./result-boundary.ts) (`no-throw-outside-boundary`, `no-try-catch-outside-boundary`): outside the boundary modules in `scripts/result-boundary-globs.ts`, requires `Result.err(...)` instead of `throw` (allowing only a synchronous re-throw of the enclosing `catch` binding and a defensive `throw panic(...)`, with `panic` resolved through its `better-result` import) and `Result.tryPromise`/`Result.try` instead of a `catch` clause; `try/finally` without `catch` is unaffected.
- [`no-unpaired-playbook-verdict`](./no-unpaired-playbook-verdict.ts) (`no-unpaired-playbook-verdict`): requires playbook verdict changes to preserve the associated reason and audit context.
- [`require-exhaustive-panic`](./require-exhaustive-panic.ts) (`require-exhaustive-panic`): rejects an exhaustiveness check that binds or returns the unhandled value (`const x: never = value`, `return value satisfies never`), both of which type-check and then hand a widened union back to the caller, and a fallback after `value satisfies never;` (`return null`, a default literal, a `break`, nothing), which swallows the miss instead; follow the assertion with `panic(...)`, `return panic(...)`, or a throw, where `panic` is resolved through its `better-result` import (an alias counts, a local or differently sourced binding does not).
- [`require-detached-label-shape`](./require-detached-label-shape.ts) (`require-detached-label-shape`): requires monitored detached work to use stable `feature.action` labels.
- [`require-eden-error-check`](./require-eden-error-check.ts) (`require-eden-error-check`): requires Eden responses to inspect or unwrap the error channel before data is consumed or escapes.
- [`require-fetch-timeout`](./require-fetch-timeout.ts) (`require-fetch-timeout`): requires network requests to carry a bounded timeout or an owned timeout wrapper.
- [`require-toast-error-capture`](./require-toast-error-capture.ts) (`require-toast-error-capture`): requires failures shown in a toast to also reach structured error capture.
- [`tagged-error-requires-message`](./tagged-error-requires-message.ts) (`tagged-error-requires-message`): requires every `TaggedError` payload to include a user- or operator-readable message.

### Architecture, configuration, AI, and type safety

- [`ai-output-strict-schema`](./ai-output-strict-schema.ts) (`ai-output-strict-schema`): requires AI structured-output schemas to reject unknown properties instead of silently accepting model drift.
- [`require-complete-compaction-generation`](./require-complete-compaction-generation.ts) (`require-complete-compaction-generation`): requires every compaction-owned text generation call to apply the shared complete-output policy before its durable checkpoint can advance.
- [`confine-owner`](./confine-owner.ts) (`confine-owner`): confines each capability in `scripts/ownership.ts` to the module that owns it; the same table renders `docs/module-ownership.md`, and a bypass is an `allowed` entry with a reason rather than a new rule.
- [`decision-shaped-output-schema`](./decision-shaped-output-schema.ts) (`decision-shaped-output-schema`): reports a call whose `outputSchema` option (the structured-output helpers' own vocabulary, and their file-local wrappers') resolves, in the same file, to a valibot object literal with no free text in it: every entry a picklist, literal, boolean, number, ISO date, or an array/object/union/optional of those. That output is a decision, so it belongs to `decide()` / `decideMany()` in `apps/api/src/lib/workflow/decisions/decide.ts`, which prices it as one and logs the reading. One `v.string()` that no `isoDate`/`isoDateTime` action pins keeps the call generative. An explicit `outputMode: "generative"` records an intentional fallback or provider-path probe. Resolution is inline or through a same-file `const`, with one level of `v.pipe(schema, ...)` peeled; a schema from another module, a spread entry list, or an unrecognized valibot call is left alone.
- [`docs-source-policy`](./docs-source-policy.ts) (`docs-source-policy`): requires every direct external dependency to be covered by one exact llms.txt source or an explained no-source quarantine that expires within 31 days.
- [`forbid-dev-runner-config-reads`](./forbid-dev-runner-config-reads.ts) (`forbid-dev-runner-config-reads`): prevents application code from importing or reading development-runner configuration.
- [`forbid-process-env-outside-env-ts`](./forbid-process-env-outside-env-ts.ts) (`forbid-process-env-outside-env-ts`): confines unvalidated environment reads (`process.env` in any spelling, `node:process` imports, `Bun.env`, and server-side `import.meta.env`) to env modules, config and test files, repository- or package-root `scripts/` and `tests/` directories, and explicitly configured files and directories.
- [`no-ambient-nondeterminism`](./no-ambient-nondeterminism.ts) (`no-ambient-nondeterminism`): rejects ambient time from `Date` and `Temporal.Now`, plus randomness, in deterministic backend policy, normalization, codec, and classification modules; callers must provide owned inputs.
- [`no-awaited-builder-union`](./no-awaited-builder-union.ts) (`no-awaited-builder-union`): avoids awaiting a union of two generic builder states, which causes disproportionate type-instantiation cost.
- [`no-bare-chrome-query`](./no-bare-chrome-query.ts) (`no-bare-chrome-query`): requires Chrome extension messaging and query operations to use the owned adapter.
- [`no-coerced-optional-union-enum`](./no-coerced-optional-union-enum.ts) (`no-coerced-optional-union-enum`): rejects coercion around optional union enums that widens or changes missing-value semantics.
- [`no-condition-combinator-outside-conditions`](./no-condition-combinator-outside-conditions.ts) (`no-condition-combinator-outside-conditions`): keeps condition-tree `combinator`/`negated` reads behind `@stll/conditions`'s own fold/walk/evaluate helpers instead of call sites re-implementing tree semantics; the condition builder in `@stll/conditions` and `@stll/workspace-ui`, and any module that imports `foldCondition`/`foldConditions` (reading the fields inside a fold `group` callback), are exempt.
- [`no-crypto-random-uuid`](./no-crypto-random-uuid.ts) (`no-crypto-random-uuid`): requires Bun's UUIDv7 generator in backend runtime code.
- [`no-eager-singleton`](./no-eager-singleton.ts) (`no-eager-singleton`): prevents side-effecting clients from being constructed at module evaluation time; use lazy getters.
- [`no-facade-imports`](./no-facade-imports.ts) (`no-facade-imports`): requires imports from the owning leaf module instead of broad facades that hide boundaries and side effects.
- [`no-nanoid`](./no-nanoid.ts) (`no-nanoid`): prevents the removed Nano ID dependency from returning; use UUIDv7 or Web Crypto for custom alphabets.
- [`no-partial-record-satisfies`](./no-partial-record-satisfies.ts) (`no-partial-record-satisfies`): rejects `satisfies Partial<Record<Union, T>>`, which defeats exhaustive companion-map checking.
- [`bun-test-hygiene`](./bun-test-hygiene.ts) (`no-focused-tests`, `no-disabled-tests`, `no-identical-title`, `no-unmanaged-database-client`): the `bun:test` counterparts of the jest/vitest hygiene rules, which do not recognise `bun:test` imports. Test functions resolve through their import (aliased or namespace member); `.only` is rejected, `.skip`/`.todo`/`xtest`/`xit`/`xdescribe` need a reason comment on the same line or directly above (the conditional `.skipIf`/`.todoIf`/`.if` forms and a disabled registration inside an `if`/ternary branch are allowed), and two tests or blocks in the same block may not share a static title; each conditional branch counts as its own block. A test may not construct a database client (`SQL` from `bun`, `drizzle` from a network driver without a `client`, `postgres`, `pg`): the gated suites share one process, so tests open clients through `apps/api/src/tests/gated-test-database.ts`, the one exempt module, which closes each client it opens.
- [`no-vacuous-throw-assertion`](./no-vacuous-throw-assertion.ts) (`no-vacuous-throw-assertion`): requires `toThrow` and `toThrowError` in tests to name the expected error; an unargumented throw assertion is satisfied by every error, so it keeps passing once the code fails for an unrelated reason. `.not.toThrow()` stays valid.
- [`no-internal-module-mock`](./no-internal-module-mock.ts) (`no-internal-module-mock`): rejects `mock.module` against a workspace module (relative, `@/`, or `@stll/` specifier) or a non-literal specifier; npm packages and runtime builtins stay valid as external boundaries, except the TanStack AI engine and adapter packages (`@tanstack/ai`, `@tanstack/ai-*`), which are a runtime whose chunk shape the code under test must be proven against: fake the adapter through the model resolver seam instead. Pairs listed in `scripts/internal-module-mock-ledger.json` are grandfathered, a listed pair whose mock is gone is reported as stale, and the ratchet keeps the ledger from growing.
- [`no-static-devtools-import`](./no-static-devtools-import.ts) (`no-static-devtools-import`): prevents development-only modules from entering eager production dependency graphs.
- [`require-function-replacer`](./require-function-replacer.ts) (`require-function-replacer`): requires function-valued state updates to use an explicit replacer wrapper so they are not invoked as updater callbacks.
- [`suppression-hygiene`](./suppression-hygiene.ts) (`require-description`, `no-foreign-directive`): requires rule-specific, explained suppressions and rejects directives for another lint engine.

## Native and shared rules

Do not recreate a project plugin when an enabled native rule expresses the same
invariant more accurately:

- `typescript/no-explicit-any` and `typescript/no-unsafe-type-assertion` replace the retired `no-any-casts`, `no-dangerous-type-assertions`, and `no-prompt-boundary-casts` plugins.
- [`result-consumption.ts`](../packages/scripts/src/result-consumption.ts) uses the TypeScript compiler's resolved Better Result types to reject discarded `Result` values without relying on callee spellings.
- `oxc/no-accumulating-spread` prevents quadratic spread accumulation in loops and reducers.
- `@stll/oxlint-config/no-raw-colors` owns semantic color-token enforcement; it is external to this directory.
- The shared `stella-lowercase` plugin owns lowercase-copy checks.

## Suppressions

Every directive must name a rule and explain the exception. Oxlint reports unused
directives as errors. `scripts/ratchet.ts` keeps per-rule suppression budgets
decrease-only; security-tier suppressions also require a matching entry in
`scripts/suppression-waivers.json`.

Adding a suppression requires the directive, its reason, any required waiver entry,
and an explicit baseline change justified in the pull request. A baseline reseed is
not a mechanical way to make CI pass.

## Retiring a rule

A rule that names one canonical helper or module is an instance guard: it exists
because a specific wrong call site was reachable, so it carries a removal
condition rather than living forever. Once the invalid state cannot be written at
all, the rule costs lint time and reading time and proves nothing, and keeping it
implies a hazard that is gone.

- Retire it when its ratchet count has been zero for a quarter, and the state it
  rejects is structurally impossible: an owner confinement row in
  [`scripts/ownership.ts`](../scripts/ownership.ts), a type that cannot express
  it, or a total map that forces a decision per member.
- A count at zero on its own is not the condition. Zero says nobody wrote the
  shape last quarter; only the structure says nobody can.
- Delete the rule, its fixture, its catalogue entry above, and its suppression
  budget in one change, so no baseline outlives the thing it measured.
- Record the retirement in the ownership row that replaced it, naming the rule:
  the row is then the only place a reader has to look.

## Adding or changing a rule

1. Put one cohesive detector in `<plugin-name>.ts`; use multiple rule IDs only when
   they share one domain boundary and lifecycle.
2. State the invariant, accepted shapes, rejected shapes, and known analysis boundary
   in the source header. Avoid naming heuristics as if they prove runtime safety.
3. Register the module and enable every rule ID in `oxlint.config.ts`.
4. Add a module-named fixture. Each exported rule needs at least one intentionally
   suppressed production-shaped violation plus meaningful accepted cases.
5. Add or update the linked catalogue entry here.
6. Run `bun scripts/check-oxlint-plugin-registry.ts` and
   `bash scripts/lint-oxlint-fixtures.sh`.
