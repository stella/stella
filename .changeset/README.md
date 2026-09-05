# Changesets

Pull requests that change the shipped source of a published package must
include a Changeset describing the user-visible change and its semver impact:

<!-- published-packages:start -->
<!-- Rendered from scripts/changeset-policy.json by `bun scripts/check-published-package-lists.ts --write`. Do not edit by hand. -->

- `@stll/ai-catalog`
- `@stll/anonymize-chat`
- `@stll/auth-model`
- `@stll/business-registries`
- `@stll/calculations`
- `@stll/chat`
- `@stll/cli`
- `@stll/conditions`
- `@stll/country-codes`
- `@stll/docx-utils`
- `@stll/money`
- `@stll/ssr-kit`
- `@stll/ssr-testkit`
- `@stll/stable-stringify`
- `@stll/start-runtime`
- `@stll/template-conditions`
- `@stll/ui`
- `@stll/workspace-model`
- `@stll/workspace-ui`

<!-- published-packages:end -->

Run `bun run changeset`, select the affected package(s), and commit the generated
Markdown file. Changes that do not alter a published package do not need one.

After Changesets are merged, the shared organization workflow maintains a
version-only pull request. Merging that pull request updates package versions,
changelogs, internal dependency ranges, and `bun.lock`. The local
`publish-npm.yml` workflow builds and packs artifacts without credentials, then
delegates the privileged, resumable npm and GitHub release transaction to the
versioned workflow in `stella/.github`.

The CLI remains an intentional exception to the trigger timing: its new version
is published only after the matching stable application release is verified in
production.
