# @stll/cli

The `stella` command-line client.

## Install

```sh
npm i -g @stll/cli
```

## Usage

The command surface (`stella <resource> <action>`) is generated from the
stella MCP tool registry, so it mirrors the tools exposed by a stella server.
Run `stella --help` to list available commands.

Authenticate against a stella server with:

```sh
stella auth login --server https://api.example.com
```

A successful login stores that server as the default, so later commands need
no `--server`. The server used by any command resolves in this order:

1. `--server <url>` on the command;
2. the `STELLA_SERVER_URL` environment variable;
3. the default written by the last successful `stella auth login`.

The login flow negotiates the server's advertised OAuth scopes. Optional
scopes unsupported by an older server are omitted; scopes passed explicitly
with `--scopes` must all be available. `--scopes` selects `stella:` resource
scopes only: the identity scopes (`openid profile email offline_access`, which
is what gets a refresh token issued) are always requested.

Set `STELLA_TIMING=1` to print phase durations to stderr: startup, token
lookup or refresh, registry lookup or refresh, the API call, and output. These
traces contain durations only. Registry projections are reused for up to 30
seconds within the same server, organization, CLI version, and credential;
access tokens are reused until they approach expiry.

## Passing input

Every generated command takes its tool's fields as flags, or the whole
tool-args object as JSON through `--input`:

```sh
stella matter save --input '{"name":"Novak v. State"}'   # inline
stella matter save --input @args.json                     # from a file
jq -n '{name:"Novak v. State"}' | stella matter save --input -   # from stdin
```

Explicit value flags override matching paths in the JSON, so `--input` can
carry the body while a flag supplies one field.

`--schema` prints the command's input JSON schema (the same schema the MCP
tool validates against) and exits, so the shape can be read without a call:

```sh
stella matter save --schema
```

A command whose tool takes a document also accepts `--file <path>`: the CLI
reads the local file and sends it in the tool's own base64 field, which is the
call an MCP host would make with the file attached. The size ceiling comes from
that field's schema and `--help` states it.

```sh
stella template create --name "Engagement letter" --file ./letter.docx
```

A file over the ceiling is refused, naming the limit; send such a document from
an MCP host that can attach it to the tool's file reference rather than
re-exporting it to fit.

## Batch operations

Run many commands with one credential resolution, registry load, and MCP session:

```sh
stella batch ops.jsonl --concurrency 6 > results.jsonl
cat ops.jsonl | stella batch - --dry-run
stella batch ops.jsonl --resume results.jsonl > resumed.jsonl
```

Each line contains a CLI command path, its `--input` payload, and an optional
caller ID, for example `{"command":"contact delete","input":{"contact_id":"<contact-id>"},"id":"remove-1"}`.
Use `stella contact delete --schema` to inspect the payload. Results are JSONL
in input order; any error or unknown outcome makes the command exit nonzero.
Concurrency defaults to 6 and is limited to 16. Files are limited to 64 MiB.
Destructive commands require `--yes`; batch never prompts.

`--dry-run` validates every line locally and makes no server requests. Resume
skips successful receipts and lists unknown outcomes for reconciliation without
resubmitting them. Keep the original input and caller IDs unchanged between runs;
combine original and resumed receipt files to retain all successful receipts.
Only capabilities whose handlers declare durable replay receive idempotency keys.
Rate-limit refusals honor the server delay and retry within a bounded budget;
uncertain writes are never retried automatically.

Bulk capabilities with an ID collection accept `--ids a,b,c` or `--ids @ids.txt` (one ID per
line), trim blanks, remove duplicates, and chunk requests at the endpoint's schema
limit. Consecutive property creates and case-law matter-link creates use equivalent
replay-capable bulk endpoints when available. Other operations retain their
individual semantics.

## Case-law coverage

Use `stella case-law coverage --json` before concluding a decision is missing.
It reports availability, decision counts, year ranges, court breakdowns, and
the data's `asOf` timestamp. Omit `--country` for all jurisdictions, or pass a
country code or name:

```sh
stella case-law coverage --country CZE --json
```

Jurisdictions in preparation report held counts; public search is unavailable.

## Legislation search

`stella legislation search --json` reports each hit's `match.type` as `strict`
or `relaxed`. A short, exhausted first corpus page can append matches ranked
by content-term coverage; strict matches appear first. Citations and known
act aliases inside the query pin the act they identify.

Continue with the returned cursor and the same query and filters. A cursor
rejected as invalid requires restarting the search.

## Timers

Use `time-timers.start` to create a timer before choosing a matter, then
`time-timers.list` to find your running and paused timers. Starting or resuming
a timer pauses your other running timer in the active organization.

Set the matter and description with `time-timers.update`. Pause and resume
retain elapsed time; `time-timers.discard` removes unconfirmed time.
`time-timers.confirm` requires a matter and an IANA timezone, creates a draft
time entry, and applies the organization's time policy. Retry confirmation
with the same timer ID to receive the original entry without creating another.
These capabilities replace the per-entry timer start and stop capabilities.

Organization owners and admins can use `time-timers.admin.list` to find running
member timers and `time-timers.admin.stop` to end one into its owner's draft
entry. Completion uses the timer description; supply `narrative` when the
description is empty and the organization requires one. Completion refuses
inaccessible matters and locked months without changing the timer. Another
member's running entries must be ended before editing or deleting them.

## Registry drift

The command surface is baked in at build time. When the server you are signed
in to lists a different set of tools, commands that consult the registry print
one line on stderr naming how many tools were added, removed or changed; add
`--verbose` to list them. `--help`, `stella auth` and `stella compatibility`
run from local state and stay silent. The line never goes to stdout, so
`--json` output stays machine-readable.

If the drift means the tool behind the command you invoked is gone from the
server, that is an error on the command itself (exit 4), not a warning.

To verify the public API contract without signing in:

```sh
stella compatibility check --server https://api.stll.app
```

Release automation runs this command from the exact packed tarball against
production before publishing a new CLI version. Compatibility is negotiated by
wire protocol, server revision, and required capabilities rather than by the
CLI package version.

## Capability execution

The CLI connects to the advanced MCP resource at `/mcp/advanced`; the default
MCP resource carries only reviewed, purpose-built tools. Skill gateway tools
are an MCP/CLI parity exception: the CLI keeps skills through the advanced
resource; `/mcp` omits them from discovery and refuses direct calls.

Generated capability commands select `read_capability` or `write_capability`
from the catalog's access classification. For an explicit capability id, use
`stella capability read --capability <id> --input '<json>'` or
`stella capability write --capability <id> --input '<json>'`. Discover its input schema with
`stella capability describe --capability <id>`.

## Links

- Repository: https://github.com/stella/stella/tree/main/packages/cli
- Issues: https://github.com/stella/stella/issues
