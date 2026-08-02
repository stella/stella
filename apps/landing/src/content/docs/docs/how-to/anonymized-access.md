---
title: Use the anonymized endpoint
description: Give an assistant read access with tenant identifiers pseudonymized on the way out.
sidebar:
  order: 2
---

Besides the standard server, stella serves a second, read-only surface:

```
https://api.stll.app/mcp-anonymized
```

Connect to it exactly like the [standard endpoint](/docs/get-started/connect-ai-assistant/).

## What it does

Responses pass through stella's anonymization pipeline before leaving the
server: names and identifying details of your workspace's people and
companies are replaced with consistent placeholders. Use it when the
assistant on the other end should reason over your matters without seeing
who they concern.

## What it does not do

- Write tools are not available on this surface.
- Public information (published court decisions, legislation) is served as
  published; anonymization applies to your tenant data, not to public
  records.
