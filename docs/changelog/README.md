# Manual Changelog Notes

Add one Markdown file per stable release and commit it together with the
matching `VERSION` bump. The file may be blank for minor releases with no
handwritten notes; the landing site still uses its presence to generate
release-specific link preview pages and version-only fallback images.

Prereleases (`vX.Y.Z-rc.N`, `vX.Y.Z-beta.N`, `vX.Y.Z-alpha.N`) stay off the
public changelog page. Their generated GitHub release notes are enough.

```text
docs/changelog/vX.Y.Z.md
```

```bash
printf "X.Y.Z\n" > VERSION
touch docs/changelog/vX.Y.Z.md
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

<video controls src="https://github.com/user-attachments/assets/example-video-id"></video>
```

The changelog page renders `#` as the manual heading, `##` as the subheading,
and safe `https://` video URLs as embedded videos. Generated commit entries keep
their clickable pull request links under a collapsed `Full release notes`
section.

Use GitHub user attachments for short videos: drag an `.mp4` into a GitHub issue,
PR comment, or release description draft, then copy the generated
`https://github.com/user-attachments/assets/...` URL into the changelog note.
Keep videos short and compressed; the website embeds the file responsively.

Stable releases (`vX.Y.Z`) generate their commit list from the previous stable
tag, so the stable release includes the changes shipped through earlier
prerelease tags for that version.
