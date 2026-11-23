# Web i18n

The app's strings live in `langs/<locale>.json`. English is imported
statically (`i18n-store.ts`), so every key in `langs/en.json` is part of the
initial bundle; the other locales load as whole catalogs when chosen.

## Feature catalogs

A feature that loads lazily can keep its strings in its own chunk instead:

```text
src/components/docx/example/
  example-host.tsx
  i18n/
    langs/en.json        # { "docxExample": { "title": "…" } }
    langs/cs.json        # every supported locale
    i18n-source-lock.json
```

- One top-level namespace per catalog, used by no app catalog. Merging a
  namespace the app already has panics.
- Declare the catalog next to the code that uses it, with one dynamic import
  per locale, so the JSON lands in that code's chunk:

  ```tsx
  const exampleCatalog = defineFeatureCatalog({
    en: async () => (await import("./i18n/langs/en.json")).default,
    cs: async () => (await import("./i18n/langs/cs.json")).default,
    // … one entry per supported locale; a missing one fails typecheck
  });
  ```

- Wrap the feature in `<exampleCatalog.Provider fallback={…}>`. The
  fallback is required: `null` for a part that mounts beside content already
  on screen, the surface's pending face otherwise, as for any other pending
  state.
- Read strings with `exampleCatalog.useTranslations()`, typed from the
  catalog's English JSON (`t("docxExample.title")`). Inside the provider,
  `useTranslations()` from `use-intl` sees the app's and the feature's
  strings together.

`bun run i18n:check` and `bun run i18n:sync` run the same checks over every
`src/**/i18n/langs` as over `langs/`, through
`scripts/i18n-feature-catalogs.ts`: the source lock and baseline beside the
catalog, keys no source in the feature names, and the translation lint. To
accept changed English for a feature catalog:

```sh
bun scripts/i18n-feature-catalogs.ts accept <langs dir> <key>…
```

The message census (`message-census.test.ts`) covers feature catalogs as part
of each locale's catalog.
