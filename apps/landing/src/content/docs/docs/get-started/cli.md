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
stella auth login
```

The login opens your browser for the standard sign-in and permission review.
Credentials are stored per server; pass `--server` to target a self-hosted
instance.

## First commands

```sh
stella --help              # list every command
stella matter list         # your matters
stella case-law search --query "contractual penalty"
```

Commands follow `stella <resource> <action>`. Destructive actions ask for
confirmation; pass `--yes` in scripts you trust.

## Verify a server without signing in

```sh
stella compatibility check --server https://api.stll.app
```

## Next steps

- The full command surface is in the [tool reference](/docs/reference/tools/).
