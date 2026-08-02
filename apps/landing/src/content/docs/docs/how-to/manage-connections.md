---
title: Manage connected apps
description: Review and revoke AI assistants and other apps connected to your organization.
sidebar:
  order: 1
---

Every assistant or app connected through OAuth appears in stella under
**Settings → Account → Connections**, together with the permissions it was
granted.

## Review connections

The connections page lists each connected app per organization. Grants are
scoped: an app only holds the permissions you approved at connect time.

## Disconnect an app

Choose **Disconnect** next to the app. This removes the grant **and revokes
its issued tokens** in the same step, so a disconnected app loses access
immediately rather than when its tokens would have expired.

## Reconnect

Reconnecting runs the normal permission review again from scratch; nothing
from the previous grant is carried over.
