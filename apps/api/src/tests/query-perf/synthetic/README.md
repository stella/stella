# Synthetic query fixtures

`seedProdShaped(db, profile)` bulk-loads an empty, migrated profile-specific
database, runs `ANALYZE`, and returns fixture identities, big and median matters,
the search term, visible search counts, row counts, and seed duration. The calling harness owns its
application-role transaction and measurement settings. Seeding does not modify
policies, indexes, planner settings, or planner statistics directly.
`readSeededProfile(db, profile)` reads the same identities and counts after a
cache restore without loading rows. Big and median matters are selected by
entity count, with workspace ID breaking ties; row totals are checked against
the selected profile.

`PLACEHOLDER_PROFILE` contains invented aggregates for generator tests.
`capturedProfileSchema` accepts only aggregate counts and fractions, capture date,
and source hash. `deriveSyntheticProfile({ profile, profileId })` validates the
profile age and derives separate small and fixed growth fixtures.
A capture older than 31 days fails; CI never reads a production database.
Public fixture counts are fixed rounded constants. Every published fraction has
at most two decimal places; positive shares have a minimum of 0.01. Common-value
frequency lists retain at most 98 shares, with the remaining mass folded into
the anonymous residual before integer-hundredths apportionment.
Each profile requires its own fresh database and snapshot key. No source values
belong in a profile. The fixture has explicit ownership of the tables in
`SYNTHETIC_TABLES`. Migration configuration and public corpora are outside it.

Workspace bucket populations become seeded weights, rescaled to the selected
fixture volume. Largest matters align across tables; bucket boundaries at the
source scale are not preserved after rescaling. Null fractions, distinct counts,
and anonymous common-value frequencies become reproducible synthetic slots.
Unbounded distinct estimates scale with fixture row counts. Finite domain
cardinalities use the rounded small count as their basis, then stay absolute
in growth; estimates are bounded by the declared synthetic domain. Exact counts use
largest-remainder apportionment and an affine permutation, evaluated by SQL
without constructing JavaScript objects for every row.

Common-value slots map to valid synthetic domain labels. For entity kinds, slot
zero is document and slot one is task. Task quotas preserve the total task
frequency while reserving enough tasks for each matter's list items and
assignees. Child allocations are projected into parent capacity while retaining each table
total. Version allocations reserve a live current version for every entity;
field allocations respect the fixed property capacity. This explicit synthetic
correlation can move rows between matters because captured histograms do not
identify corresponding matters. Infeasible totals fail before inserting data.
Aggregate marginals cannot recover source label identities or correlations.
The returned search count uses the measured query builder under default-member
permissions without feature grants and includes only current-version rows.
It must exceed the default page limit. Search languages map synthetic ISO codes
to supported PostgreSQL configurations, and search timestamps preserve the
current-version projection's freshness requirement.

Fields use synthetic text payloads sized from column width; searchable payloads
and encrypted-content byte fixtures use the table width. Extraction bytes are
synthetic payloads for database measurements; they are not application ciphertext
and must not be sent to application decryption flows.

The seeded PRNG controls allocation and column permutations. Identities and the
epoch are fixed; SQL `generate_series` performs bulk insertion. A transaction
contains the load, and temporary staging tables disappear at commit. The
database must be disposable and have no populated fixture tables.

See [snapshot.md](snapshot.md) for exact-key Actions caching and measured restore
duration. Cache download time and PostgreSQL restore time are separate metrics.

Monthly recapture uses the private read-only aggregate script. Review the output
before replacing the committed profile; keep captures and query plans outside
the repository. Record an explicit prior-capture volume ratio when a baseline
exists, and require review when volume doubles. An initial capture records
`priorCapture: null`; it does not claim a measured growth ratio. Growth coverage
for an empty captured table must declare an `assumed` distribution explicitly.
