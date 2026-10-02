# Safe Chain release mirror

The action tries the upstream release first, then the public
[`stella/.github` mirror](https://github.com/stella/.github/releases).
Both sources must match the pinned installer hash; the verified installer
supplies the binary hash. Cache hits are verified too. A hash mismatch fails
installation rather than trying another source.

Before changing the action's pinned `version` and `sha256`, publish
`mirror-safe-chain-<version>` in `stella/.github` with the byte-identical
`install-safe-chain.sh` and `safe-chain-linuxstatic-x64`, upstream `LICENSE`,
and the corresponding source archive. Verify the installer against the new
pin and the binary against that verified installer before upload, then download
the public mirror assets without authentication and verify the hashes again.
Keep the source available with the mirrored binary as required by upstream's
AGPL license. Never execute the installer to obtain its hash or its binary pin.

The `safe-chain-cache.yml` workflow warms the same verified binary cache in
main's scope on every push to main and daily; PRs and merge groups can restore it.
