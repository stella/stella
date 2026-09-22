# Manual Changelog Notes

Add one Markdown file per stable release and commit it together with the
matching `VERSION` bump. The landing site uses it to generate release-specific
link preview pages and version-only fallback images.

A stable release is either a maintenance release or shows what changed.
`bun run release:maintenance` writes a note headed `# Maintenance release`;
every other stable release note must embed at least one screenshot or video
(see the example below). `scripts/check-release-changelog.sh` refuses the
release pull request and the tag otherwise.

Prereleases (`vX.Y.Z-rc.N`, `vX.Y.Z-beta.N`, `vX.Y.Z-alpha.N`) stay off the
public changelog page. Their generated GitHub release notes are enough.

```text
docs/changelog/vX.Y.Z.md
```

```bash
printf "X.Y.Z\n" > VERSION
$EDITOR docs/changelog/vX.Y.Z.md
git add VERSION docs/changelog/vX.Y.Z.md
git commit -m "chore: release vX.Y.Z"
```

When the file contains manual notes, the release workflow prepends the matching
file to the generated release notes, adds a `## Changes` heading, then appends
the categorized git-cliff commit list below it. Keep the manual section short
and product-facing.

Example:

```markdown
# Table improvements

## We are shipping faster table editing, cleaner sorting, and smoother bulk actions.

![A table with the updated sorting controls](https://github.com/user-attachments/assets/example-image-id)

<video controls src="https://github.com/user-attachments/assets/example-video-id"></video>
```

The changelog page renders `#` as the manual heading, `##` as the subheading,
Markdown images with safe `https://` URLs as responsive screenshots, and
`<video controls src="https://..."></video>` as an embedded video. Generated
commit entries keep their clickable pull request links under a collapsed
`Full release notes` section.

Use GitHub user attachments for screenshots and short videos. Paste an image
into a GitHub issue, PR comment, or release description draft, then copy its
generated Markdown into the changelog note. For a video, drag in an `.mp4` and
put its `https://github.com/user-attachments/assets/...` URL in the `<video>`
element shown above. Keep videos short and compressed; the website embeds the
file responsively.

Stable releases (`vX.Y.Z`) generate their commit list from the previous stable
tag, so the stable release includes the changes shipped through earlier
prerelease tags for that version.
