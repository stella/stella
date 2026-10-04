# OSV-Scanner release mirror

OSV-Scanner is free, open-source software under Apache-2.0; it requires no
account, paid plan, trial, or payment method. Its OSV data includes OpenSSF
malicious-package advisories, independent of Safe Chain's Aikido feed.
The caller gates on active `MAL-` findings only; vulnerability advisories
remain owned by `scripts/dependency-audit.ts`.

The action tries the upstream Linux AMD64 release, then the public
[`stella/.github` mirror](https://github.com/stella/.github/releases).
Downloads and cache hits must match the pinned SHA-256. A hash mismatch
fails installation without trying another source.

Before changing `version` and `sha256`, publish
`mirror-osv-scanner-v<version>` in `stella/.github` with the byte-identical
`osv-scanner_linux_amd64` and upstream `LICENSE` from that version's tag.
Verify the binary against the new pin before upload, then download the public
mirror assets without authentication and verify both files' hashes again.
