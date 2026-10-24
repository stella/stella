# Disabled registration inventory

`test-gate-disabled.json` records existing disabled registrations; the guard
requires an exact match and reports stale entries as well as unlisted skips.

The PostgreSQL registrations for decision citation statistics, reader answer
settlement deadlines, reader answer related citation directions, and the public
read statement timeout are skipped placeholders when `STELLA_RUN_POSTGRES_TESTS`
is not `true` or `DATABASE_URL` is absent. Their active branches run in the
gating PostgreSQL service job. The named PostgreSQL and Valkey placeholders are
listed explicitly so an unconditional `skip` or `todo` cannot inherit the
managed-gate exemption, including inside a service-enabled branch.

The installed Docker CLI resolution test is skipped on Windows or when
`Bun.which("docker")` cannot find the Docker CLI. It exercises the installed CLI
against Unix socket daemons, so those platform and tool-availability conditions
are part of the test's existing scope.

The Windows dry-run executable-boundary test is skipped on Windows because it
creates and executes a shebang fixture. Its executable-boundary assertions run
on the Unix CI runner; the platform condition is already present in the test.

Dynamic registrations controlled by a managed service gate are exempt regardless
of whether their title is statically known. Calls to runner utilities such as
`test.info().outputPath(...)` are not registrations and have no inventory entry.
