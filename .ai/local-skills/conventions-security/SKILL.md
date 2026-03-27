# Security Conventions

Apply when writing code that touches auth, data access, file
handling, or external APIs. Stella handles privileged legal data
(attorney-client privilege, litigation holds, personal data).

## SOC 2 / ISO 27001 Principles

- **Least privilege** — minimum permissions needed. No wildcard
  IAM policies, no admin-by-default.
- **Audit trail** — state-changing operations traceable to an
  actor and timestamp. Never silently mutate data.
- **Encryption in transit and at rest** — TLS everywhere, S3 SSE,
  no plaintext secrets in code or logs.
- **Input validation at boundaries** — all external input
  validated and sanitised before processing.
- **Workspace isolation** — data from one workspace must never
  leak to another.
- **Ethical walls** — workspace boundaries enforce Chinese walls.
  Zero visibility into unassigned workspaces: no names, no
  members, no metadata. Absolute confidentiality.
- **Access control** — every endpoint enforces auth and
  authorisation. No "internal-only" endpoints without guards.
- **Dependency hygiene** — minimal, pinned, audited.
- **Logging without leaking** — never log secrets, tokens, PII,
  or document contents.
- **Change management** — all changes go through PR review. No
  direct commits to main.
- **Data retention** — when data is deleted, it is actually
  deleted (not soft-deleted indefinitely).
