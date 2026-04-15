# Publishing `@stella/infosoud`

This package is published from `packages/infosoud`, not from the monorepo root.

## Release Checklist

1. Review the package surface:
   - `README.md`
   - `package.json`
   - exported API from `src/index.ts`
2. Bump `version` in `package.json`.
3. Run the package checks:

```sh
cd packages/infosoud
bun run release:check
```

This runs:

- `bun run lint`
- `bun run typecheck`
- `bun run test`
- `bun run build`
- `bun run pack:dry-run`

4. If the package already exists on npm, check the currently published version:

```sh
npm view @stella/infosoud version
```

5. Publish from the package directory:

```sh
cd packages/infosoud
bun publish --access public
```

## Notes

- `bun publish` from the package directory will run lifecycle scripts such as
  `prepack`, so the package builds before publish.
- Publishing a prebuilt tarball is different: lifecycle scripts do not run, so build
  first if you ever switch to tarball-based publishing.
- `bun pm pack --dry-run` is the cheapest way to inspect what will actually ship.
