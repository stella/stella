# UI playground snapshots

This suite captures focused, deterministic states from the existing `/dev` UI
playground. It runs in CI only when the shared UI package or the playground's
rendering contract changes.

Run the check with:

```sh
bun --filter @stll/web test:e2e:ui-playground
```

After an intentional visual change, review and regenerate the light, dark, and
right-to-left baselines with:

```sh
bun --filter @stll/web test:e2e:ui-playground:update
```

The committed PNGs use Linux font rendering. Regenerate canonical baselines in
the Playwright CI image; screenshots produced on macOS are useful for local
review but should not replace the committed files.
