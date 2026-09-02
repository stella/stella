---
title: Set up the CLI
description: Install the stella command-line client and sign in.
sidebar:
  order: 2
---

The `stella` CLI is generated from the same tool registry as the server's MCP
surface, so its commands mirror what an assistant can do, with the same
permission model.

## Install

```sh
npm i -g @stll/cli
```

## Sign in

```sh
stella auth login --server https://api.stll.app
```

The login opens your browser for the standard sign-in and permission review.
The first login needs `--server`, because no server address is built into the
CLI; it becomes the default afterwards. Credentials are stored per server, so
`--server <url>` on any command (or the `STELLA_SERVER_URL` environment
variable) switches to another one, self-hosted included.

## First commands

```sh
stella --help                                   # list every command
stella matter list                              # your matters
stella search matters --query "contractual penalty"
stella document content --entity-id <id>        # a document's text
```

Commands follow `stella <resource> <action>`. Destructive actions ask for
confirmation; pass `--yes` in scripts you trust.

Some groups (`case-law`, `legislation`, `time-entry`, `rate`, `invoice`,
`usage`) depend on server features: where a deployment has one turned off, its
commands exit with code 5.

## Verify a server without signing in

```sh
stella compatibility check --server https://api.stll.app
```

## Next steps

- The full command surface is in the [tool reference](/docs/reference/tools/).
