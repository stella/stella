# @stll/cli

The `stella` command-line client.

## Install

```sh
npm i -g @stll/cli
```

## Usage

The command surface (`stella <resource> <action>`) is generated from the
Stella MCP tool registry, so it mirrors the tools exposed by a Stella server.
Run `stella --help` to list available commands.

Authenticate against a Stella server with:

```sh
stella auth login
```

The login flow negotiates the server's advertised OAuth scopes. Optional
scopes unsupported by an older server are omitted; scopes passed explicitly
with `--scopes` must all be available.

To verify the public API contract without signing in:

```sh
stella compatibility check --server https://api.stll.app
```

Release automation runs this command from the exact packed tarball against
production before publishing a new CLI version.

## Links

- Repository: https://github.com/stella/stella/tree/main/packages/cli
- Issues: https://github.com/stella/stella/issues
