# Disabled registration inventory

`test-gate-disabled.json` records existing disabled registrations; the guard
requires an exact match and reports stale entries as well as unlisted skips.

The named PostgreSQL and Valkey suites added to the inventory are skipped
placeholder suites in the branch where the service gate or connection is absent.
Their corresponding active branches run in the gating service job. Listing these
placeholders explicitly keeps an unconditional `skip` or `todo` from inheriting
the managed-gate exemption, including inside a service-enabled branch.

Dynamic registrations controlled by a managed service gate are exempt regardless
of whether their title is statically known. Calls to runner utilities such as
`test.info().outputPath(...)` are not registrations and have no inventory entry.
