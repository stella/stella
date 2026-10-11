# @stll/external-contracts

The closed external-service registry owns transport assignments, SDK pins,
fixture provenance and replay mechanisms. `scripts/check-external-contracts.ts`
reads the repository and checks it offline; it never contacts a service.

Every outbound census row has one primary contract. A module that supports
several protocols can appear as a shared owner in another entry (for example,
custom model endpoints and real AWS S3). A shared declaration does not satisfy
a missing primary assignment. Local loading and first-party clients are enrolled
explicitly because the transport census also contains those surfaces.

The catalog is partitioned between registry SDKs and reasoned in-process
packages. New catalog names fail regardless of their naming convention. The
same transport classifier discovers SDKs in workspace dependency declarations.

Current pins come from the actual manifests, resolved SDK versions in
`bun.lock`, applicable patch bytes, CI service image digests and API-version
constants. Fixture receipts record the pins, owners and SDKs exercised by a
fixture set. A changed pin or coverage scope requires re-characterisation.
Publisher captures retain their existing hash sidecars and their honest legacy
provenance; an unversioned publisher has no invented upstream release number.

Provider wire provenance stays in each cassette. Its fixture-set receipt sits
beside the corpus in `provider-wire.source.json`; request schemas retain their
existing `.source.json` sidecars. Specification refreshes preserve replay
receipts: downloading a schema does not re-characterise an adapter. Recorded,
synthetic-from-spec and redacted-prod-shape are the supported provenance kinds;
the existing cassette `synthetic` spelling denotes synthetic-from-spec.

The `uncharacterised` entries state the remaining coverage boundary. The check
compares their IDs with the merge-base registry, so the set may only shrink
once the initial enrollment lands. A recorded fixture receipt describes
existing coverage, not exhaustive behavior of every endpoint.

Run the offline guard with `bun run check:external-contracts`. Existing replay
owners remain responsible for executing fixtures: provider wire uses
`apps/api/src/lib/tanstack-ai-provider-wire.test.ts`, publisher fixtures use the
parser and provenance tests, and the API's `test:corpus`, `test:postgres` and
`test:valkey` scripts run container-backed contracts. S3 coverage includes the
wire fake and the existing RustFS presign smoke; real AWS S3 remains uncovered.
The registry check itself needs no containers or network.

After a pin or coverage change, run the owning offline replay (or pinned local
container suite), inspect its results, then update the fixture receipt's
`characterisedAt`, `coveredOwners` and `coveredSdks` from the real sources.
Changing receipt values alone does not establish new behavior coverage.

## License

Apache-2.0
