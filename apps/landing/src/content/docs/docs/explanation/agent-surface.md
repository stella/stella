---
title: How the agent surface is built
description: One registry drives the MCP server, the CLI, and the in-app assistant; guards keep them from drifting.
---

stella's design principle is that everything a human can do in the app is
equally available to scripts and AI agents, under the same permission model.
Instead of maintaining three integrations, stella maintains one **tool
registry** and projects it three ways:

- the **remote MCP server** advertises the registry to connected assistants;
- the **CLI** is code-generated from a committed registry snapshot, so
  `stella <resource> <action>` mirrors the tool surface;
- the **in-app assistant** works from the same registry through a sandboxed
  execution layer.

## Why it cannot drift

Each projection is guarded in CI: the committed registry snapshot, the
capability catalog, and the generated CLI tree are all diffed against the
live registry on every change. A tool added or changed in one place is a
reviewable diff in the others, never a silent divergence.

## Permissions

Access is scoped twice: OAuth scopes decide which tools a connection can see
and call, and every call is authorized against the organization and
workspace it touches, the same checks the app itself uses. Destructive tools
additionally require an explicit confirmation from the caller.

## Self-hosting

A self-hosted stella serves the identical surface: the endpoints and CLI in
these docs work against your own instance by swapping the host.
