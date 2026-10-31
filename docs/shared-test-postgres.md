# Shared test Postgres

Database-only tests share one Postgres container per host. Each checkout has
a database derived from its canonical absolute path. The shared login
`stella_test_owner` owns the test databases, can create fixture databases and
roles, and has neither superuser nor RLS bypass privileges. These are trusted
local test workers, not a security
boundary between mutually untrusted users.

```sh
bash scripts/shared-test-postgres.sh prepare --tree "$PWD"
```

The command uses the existing development Docker endpoint and keeper policy,
builds the committed Postgres image on first use, and publishes port 15432 only
on loopback. One persistent volume holds all worker databases. The container
has a 512 MiB memory ceiling and 64 MiB shared buffers. Credentials live in
private files under `~/.local/state/stella/shared-test-postgres`, outside the
repository. Its JSON response contains the database name, the migration-history template name, and a `urlFile` path.
The mode-600 file contains the URL; credentials never appear on stdout.

An environment helper can consume that response and link private overlays
for `.env`, `apps/api/.env` and `apps/api/.env.test`. It preserves other source
settings, including the configured Redis service, and sets `NODE_ENV=test` in
the test overlay. The canonical checkout must contain this command and have
dependencies before a checkout hook invokes it for a fresh worker.

Checkout hooks run before a new worktree has dependencies. The canonical checkout's
installed migration runtime reads the worker's committed migration folder and builds
its template. Template identity hashes the ordered migration directory names and SQL
contents, so workers with identical histories share one template while older or newer
histories receive distinct schemas. The local template runner guards replay of
cluster-wide NOLOGIN role creation; committed migration SQL and ledger hashes stay
intact. Installed workers use their own runtime for online repairs.

A prepared worker database is bound to its migration history. After changing migrations,
run `drop --tree <worker>` followed by `prepare --tree <worker>` to replace its test
database with the new history, then run selected files through
`bun --filter @stll/api test:postgres <test-file>`.

Both worktree cleanup paths call the idempotent command before removing the
checkout. A failed drop preserves the checkout for repair:

```sh
bash scripts/shared-test-postgres.sh drop --tree "$PWD"
```

Drop removes only that checkout's database and runs bounded cleanup of idle history
templates. Active worker databases retain their templates. The shared credentials,
login, container, volume and other workers' databases remain. Prepare and drop both
run template GC. Run `bash scripts/shared-test-postgres.sh gc` explicitly to reclaim
unreferenced templates after 24 hours; active worker references prevent expiry. Cluster-wide role
setup and migrations are serialized with a Postgres advisory lock; ordinary
tests in different databases can run concurrently.

Full application or browser e2e still requires `bun run agent:up`: the shared
database does not provide a signed-in app, object storage, or a per-worker
Redis service. Follow the `dev` skill for that stack.

The focused lifecycle test prepares three workers concurrently: two omit a fixture
migration present in a synthetic canonical checkout, and one matches that newer history.
The workers have migration files without installed dependencies.
It checks template reuse, older/newer schema differences, owner posture, isolated table
contents, idempotent cleanup, active-template retention, and idle-template expiry:

```sh
STELLA_RUN_SHARED_POSTGRES_TESTS=true bun --filter @stll/api test scripts/shared-test-postgres.test.ts
```

Respect host load gates for this service-backed test. Measure the container
with `docker stats --no-stream stella-shared-test-postgres`; process RSS can
double-count shared pages and differs from Docker's memory accounting.
