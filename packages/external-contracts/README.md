# @stll/external-contracts

The closed external-service registry owns transport assignments, SDK pins,
fixture provenance and replay mechanisms. `scripts/check-external-contracts.ts`
reads the repository and checks it offline; it never contacts a service.

Every outbound census row has one primary contract. A module that supports
several protocols can appear as a shared owner in another entry (for example,
custom model endpoints and real AWS S3). A shared declaration does not satisfy
a missing primary assignment. Local loading and first-party clients are enrolled
explicitly because the transport census also contains those surfaces.

Every direct dependency name in the root catalog and workspace manifests is
partitioned between registry SDKs and reasoned in-process packages, including
workspace packages and optional or peer dependencies. New in-process entries
require a non-empty, package-specific reason; each dependency must still appear
in exactly one classification. The transport census independently
classifies owner paths and SDKs, so SDK naming conventions cannot hide a client.

Current pins come from the actual manifests, resolved SDK versions in
`bun.lock`, applicable patch bytes, CI service image digests and API-version
constants. Fixture receipts record the pins, owners and SDKs exercised by a
fixture set. A bounded static runtime-import graph starts at each replay entry
point and proves which repository owner paths and registry SDKs are reachable;
it parses source without executing modules. A changed pin or coverage scope
requires re-characterisation. Existing pin drift can be recorded in
`scripts/external-contract-pin-allowances.json` with exact current values and an
expiry no more than seven days after its checked date. An allowance applies only
while those pins match the merge base and no executable code has changed in
any registered owner's local runtime import closure that reaches a pinned SDK.
Image and API-version pins cover every registered owner's runtime closure, regardless of SDK imports.
Relative and workspace package imports resolve independently against the merge base and current tree;
external packages stop traversal. Changed, added or removed reachable files
invalidate the allowance, including calls through derived clients and aliases.
Unresolved local imports and non-literal runtime module references fail closed
in every owner closure, including those without known SDK reachability.
Pins absent from the merge base are additions: they cannot receive a dated
allowance, and their current receipts must cover them. Derived generated modules are closure leaves represented by their tracked
generator inputs from `scripts/generated-files.ts`; checks never run generators
on the merge-base tree. Code inputs and their runtime import closures use the executable comparison, and
data leaves compare their snapshot Git blob identities without loading content or consuming the source byte budget. Unknown generated modules or
generators without declared inputs fail closed. Comments and type-only
changes keep the allowance. New unregistered SDK
usage still fails the closed census. Removed patch pins use the explicit
`<removed>` value. The existing `dated-waiver-expiry` job rejects an elapsed
allowance on every merge candidate, even when package checks are not selected.
Receipts include every declared owner path, including shared assignments.
Publisher captures retain their existing hash sidecars and their honest legacy
provenance; an unversioned publisher has no invented upstream release number.

Provider wire provenance stays in each cassette. Its fixture-set receipt sits
beside the corpus in `provider-wire.source.json`; request schemas retain their
existing `.source.json` sidecars. Specification refreshes preserve replay
receipts: downloading a schema does not re-characterise an adapter. Recorded,
synthetic-from-spec and redacted-prod-shape are the supported provenance kinds;
the existing cassette `synthetic` spelling denotes synthetic-from-spec.

The `uncharacterised` entries state the remaining coverage boundary. Their
owner and SDK scopes each require a reason, must partition the entry's declared
scope, and are compared with the merge-base registry so they may only shrink
once initial enrollment lands. A recorded fixture receipt describes existing
coverage, not exhaustive behavior of every endpoint. Updating receipt metadata
cannot invent reachability: covered owners and SDKs must be discovered from the
static replay graph.

Run the offline guard and its focused tests with
`bun run check:external-contracts`. Existing replay
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
