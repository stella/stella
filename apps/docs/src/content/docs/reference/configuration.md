---
title: Configuration
description: Environment variables and configuration options.
---

stella is configured via environment variables. All variables are documented below.

| Variable                  | Description                                                                   | Required |
| ------------------------- | ----------------------------------------------------------------------------- | -------- |
| `DATABASE_URL`            | PostgreSQL connection string                                                  | Yes      |
| `S3_ENDPOINT`             | S3 or S3-compatible object storage endpoint                                   | Yes      |
| `S3_BUCKET`               | S3 bucket name for file storage                                               | Yes      |
| `S3_REGION`               | S3 region                                                                     | Yes      |
| `S3_CREDENTIALS_PROVIDER` | Credential source: `auto`, `env`, `aws-runtime`, or `none`                    | No       |
| `S3_ACCESS_KEY_ID`        | Static object storage access key, required when `S3_CREDENTIALS_PROVIDER=env` | No       |
| `S3_SECRET_ACCESS_KEY`    | Static object storage secret key, required when `S3_CREDENTIALS_PROVIDER=env` | No       |

Full reference coming soon.
