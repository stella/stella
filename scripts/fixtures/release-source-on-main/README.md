`commit-8464c9e6-pulls.json` is the public response of
`GET repos/stella/stella/commits/8464c9e631150b801530dc854a7155d209f66e33/pulls`,
trimmed to the fields `scripts/check-release-source-on-main.sh` reads. The v0.9.72
release commit was squash-merged, so main carries the pull request's merge commit
instead of the release commit itself.

The test replays it against a synthetic repository with the same shape: its
`head.sha` and `merge_commit_sha` are substituted with the fixture repository's
release-branch commit and squash commit. Tests run offline.
