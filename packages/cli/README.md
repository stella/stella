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
