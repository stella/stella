---
title: Installation
description: How to set up stella locally or deploy to production.
---

## Prerequisites

- [Bun](https://bun.sh) v1.3 or later
- PostgreSQL 18+
- S3-compatible object storage

## Quick start

```bash
git clone https://github.com/stella/stella.git
cd stella
bun install
bun run dev
```

The web app will be available at `http://localhost:3000` and the API at `http://localhost:3001`.

## Environment variables

Copy the example environment files and fill in your values:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

Refer to the [configuration reference](/reference/configuration/) for all available options.
