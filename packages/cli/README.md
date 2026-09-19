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

## Links

- Repository: https://github.com/stella/stella/tree/main/packages/cli
- Issues: https://github.com/stella/stella/issues
