# Changesets

Pull requests that change the shipped source of `@stll/ai-catalog`,
`@stll/anonymize-chat`, `@stll/auth-model`, `@stll/chat`, `@stll/cli`,
`@stll/business-registries`, `@stll/calculations`, `@stll/conditions`,
`@stll/country-codes`, `@stll/docx-utils`, `@stll/money`,
`@stll/stable-stringify`, `@stll/template-conditions`, `@stll/ui`,
`@stll/workspace-model`, or `@stll/workspace-ui` must include a Changeset
describing the user-visible change and its semver impact.

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
