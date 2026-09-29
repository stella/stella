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
Markdown file. Every package named by an added or edited entry must have a
release-gated file in the same pull request; CI and the pre-push guard enforce
this. Name only packages whose user-visible change the summary describes.
A lint comment or test-only edit does not by itself justify a package bump;
use `bun run changeset --empty` when no public behavior changes. The path check
cannot infer semantic impact or assign different summaries within a pull request.
Changes that do not alter a published package do not need a changeset.

Pending entries are applied by whichever flow gets there first. `bun run
release:maintenance` applies them in the release commit, so the release carries
the package versions, package changelogs and consumed entries the version-only
pull request would have produced. While a release pull request is open, the
shared organization workflow stands down; otherwise it maintains a version-only
pull request for a package release between application releases. Either way the
result is the same bytes, produced by the same `changeset:version` script. The
local `publish-npm.yml` workflow builds and packs artifacts without credentials,
then delegates the privileged, resumable npm and GitHub release transaction to
the versioned workflow in `stella/.github`.

The CLI remains an intentional exception to the trigger timing: its new version
is published only after the matching stable application release is verified in
production. A stable release tag is still refused while a pending changeset
names `@stll/cli`, which a release preparation satisfies by applying the entry
rather than by waiting for another pull request (see `docs/releases.md`).
