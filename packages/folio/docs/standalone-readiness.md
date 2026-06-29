# Folio standalone-publishability audit

What it would take to build and publish `@stll/folio` as a self-contained
package, consumable outside this monorepo. This is an inventory of the couplings
to the monorepo and the concrete steps to remove each. It is a checklist, not a
plan of record; nothing here is done yet.

Source scanned: `packages/folio/src` (387 non-test `.ts`/`.tsx` files),
`package.json`, `tsconfig.json`.

## Verdict

Folio is close. The headless `core/` and the React chrome are now free of the
app design system (`@stll/ui` was removed; a package-wide arch test keeps it
out). The remaining couplings are mechanical:

1. four internal `@stll/*` packages it depends on (all private today),
2. `catalog:` version references (a monorepo-only construct),
3. a `tsconfig` that extends a shared config and reaches a repo-root type
   augmentation,
4. no build step (exports point at `.ts` source),
5. lint/format tooling that runs from the repo root.

None are architectural; they are packaging tasks.

## 1. Dependency closure

### Internal `@stll/*` packages (must be published or vendored)

Folio imports three; the third pulls in a fourth. The closure is exactly these
four, and every leaf is self-contained (no further `@stll/*` edges):

| Package                     | Imports in folio | Own `@stll/*` deps | `private` | Notes                                       |
| --------------------------- | ---------------- | ------------------ | --------- | ------------------------------------------- |
| `@stll/docx-core`           | 8                | none               | yes       | has `exports`; publishable as-is            |
| `@stll/docx-utils`          | 1                | none               | yes       | no `exports` field — add one before publish |
| `@stll/template-conditions` | 1                | `@stll/conditions` | yes       | re-exports condition logic                  |
| `@stll/conditions`          | (transitive)     | none               | yes       | only dep is `valibot`                       |

Action: either publish these four to the registry (flip `private`, add `exports`
to `docx-utils`, version them) and depend by version, **or** vendor them into the
standalone package. Publishing is cleaner (they are reusable); vendoring is
faster for a first cut. The closure is small and clean either way.

### `catalog:` references (must become concrete versions)

`catalog:` resolves only inside this workspace. A standalone `package.json` must
pin each to the version the catalog currently points at:

| Dep                                      | catalog version                       |
| ---------------------------------------- | ------------------------------------- |
| `@base-ui/react`                         | 1.6.0                                 |
| `better-result`                          | 2.9.2                                 |
| `jszip`                                  | 3.10.1                                |
| `lucide-react`                           | 1.21.0                                |
| `valibot`                                | 1.4.1                                 |
| `fast-check` (dev)                       | ^4.8.0                                |
| `react` / `react-dom` / `@types/*` (dev) | react19 catalog (react ^19.2.7, etc.) |

### Peer dependencies (already correct)

`react ^19`, `react-dom ^19`, `use-intl >=4`. `use-intl` is a real coupling — 9
chrome files use it for i18n — but a peer dep is the right shape (the consumer
provides it). Making i18n optional is possible later but not required.

### Public npm deps (no action)

`@fontsource/*`, `prosemirror-*`, `yjs`, `y-prosemirror`, `marked`,
`fast-xml-parser`, `utif2`, `csstype` are all public — fine as-is.

## 2. tsconfig coupling

```jsonc
{
  "extends": "@stll/typescript-config/react-library.json", // -> ./library.json
  "include": ["src", "../../types"], // reaches repo root
}
```

- `extends` chains through a private config package. Inline the resolved
  `compilerOptions` (notably `lib: [ESNext, DOM, DOM.Iterable]`, `jsx:
react-jsx`, plus the base `library.json`) into a standalone `tsconfig.json`.
- `../../types` pulls in `types/react-css-properties.d.ts` — a global module
  augmentation adding `--*` custom properties to React's `CSSProperties`. Folio
  relies on it (CSS variables in `style={{}}` without casts). Vendor this small
  ambient `.d.ts` into the package and include it locally.

## 3. Build / publish gap

`exports` map to `./src/*.ts` directly; there is no `build` script, `main`,
`module`, `types`, or `dist`, and `private: true`. Today the monorepo consumes
folio as source. To publish:

- Add a build (e.g. `tsdown` or `tsc` emitting `dist/` + `.d.ts`), or
  deliberately ship source for bundler-only consumers.
- Point `exports` at the built artifacts (keep the same four subpaths: `.`,
  `./core`, `./markdown`, `./server`, plus `./editor.css`).
- Flip `private: false`, set a real version, keep `sideEffects: ["**/*.css"]`.
- The `./editor.css` export now also carries the default-chrome styles
  (`.folio-default-*`); make sure the build copies CSS.

## 4. Tooling coupling

`lint`/`format`/test run from the repo root and use:

- `oxlint.config.ts` + the custom `.oxlint-plugins/folio-layer-boundaries.ts`
  plugin (layer-boundary rules) and the folio-scoped overrides.
- The arch tests (`react-free-core`, `model-purity`, `no-design-system`) — these
  are self-contained Bun tests and travel with `src`, no change needed.

A standalone package needs its own `oxlint`/`oxfmt` config and a copy of the
folio-layer-boundaries plugin. Mechanical, but do not forget the plugin or the
boundary guarantees lapse.

## Extraction checklist (ordered)

1. Publish or vendor the four `@stll/*` packages (closure above).
2. Replace every `catalog:`/`workspace:*` with a concrete version.
3. Inline the `tsconfig` (resolve `extends`; vendor `react-css-properties.d.ts`).
4. Add a build step; point `exports` at `dist`; flip `private`, set version.
5. Vendor the oxlint config + `folio-layer-boundaries` plugin; keep the arch
   tests.
6. Verify in isolation: install in a throwaway app, import `@stll/folio` and
   `@stll/folio/core`, render the editor, run the test suite.

Steps 1–4 are required; 5 preserves the internal boundaries; 6 is the
acceptance gate.
