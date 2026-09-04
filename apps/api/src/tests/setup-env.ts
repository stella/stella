import { configureTestDatabaseEnvironment } from "./test-database-environment";

configureTestDatabaseEnvironment();
process.env["S3_ENDPOINT"] ??= "http://localhost:9000";
process.env["S3_BUCKET"] ??= "stella";
process.env["S3_REGION"] ??= "us-east-1";
// RustFS development credentials from docker-compose.yml. Tests that build
// an S3 client (Bun or SDK v3) need these even when they only sign
// URLs in memory and never hit S3. `S3_CREDENTIALS_PROVIDER` is left
// at its default `auto` so the credential-resolution tests in
// `s3.test.ts` (which mock ECS/IMDS responses) still exercise the
// real resolver path.
process.env["S3_ACCESS_KEY_ID"] ??= "stella-rustfs-dev";
process.env["S3_SECRET_ACCESS_KEY"] ??= "stella-rustfs-dev-secret";

// Bun auto-loads the developer-local (gitignored) apps/api/.env into
// `bun test`. Real social-provider credentials there flip the auth
// capabilities endpoint to `available` and break the hermetic
// "unavailable when not configured" test in
// handlers/auth/metadata.test.ts. Force the unconfigured baseline; no
// test needs live provider credentials.
delete process.env["GOOGLE_AUTH_CLIENT_ID"];
delete process.env["GOOGLE_AUTH_CLIENT_SECRET"];
delete process.env["MICROSOFT_AUTH_CLIENT_ID"];
delete process.env["MICROSOFT_AUTH_CLIENT_SECRET"];
delete process.env["MICROSOFT_AUTH_TENANT_ID"];
// Same leak, different blast radius: a developer .env that turns corpus
// object storage on sends ingestion tests down the real S3 write path, where
// they fail against a bucket the test runner has never created. Tests assert
// on the Postgres copy, so force the mode off rather than leaving hermeticity
// to whatever each machine happens to have configured.
delete process.env["CORPUS_STORAGE_MODE"];
delete process.env["CORPUS_STORAGE_ENABLED"];
delete process.env["CORPUS_INDEX_ENDPOINT"];
delete process.env["CORPUS_INDEX_SEARCH_ENDPOINT"];
delete process.env["LEGAL_SEARCH_PROVIDER"];
// A developer case-law database URL disables the local corpus-index endpoint
// through the production invariant. Unit tests stub the index transport and
// require that endpoint only to build request URLs, so keep both sides local.
delete process.env["PUBLIC_LAW_DATABASE_URL"];
delete process.env["PUBLIC_LAW_DATABASE_POOL_MAX"];
delete process.env["CASE_LAW_DATABASE_URL"];
delete process.env["CASE_LAW_DATABASE_POOL_MAX"];

// A fixed key so suites run the real AES-GCM content encryption instead of a
// module mock; the value is test-only and derives per-organization keys the
// same way production does.
process.env["CONTENT_ENCRYPTION_KEY"] ??= "0123456789abcdef".repeat(4);

process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["BETTER_AUTH_SECRET"] ??= "x".repeat(32);
process.env["BETTER_AUTH_URL"] ??= "http://localhost:3001";
process.env["EMAIL_PROVIDER"] ??= "smtp";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";
process.env["TRANSACTIONAL_EMAIL_FROM"] ??= "test@example.com";
process.env["FRONTEND_URL"] ??= "http://localhost:3000";
// Never reached by tests: corpus-index tests stub global fetch and only
// assert on the request contract.
process.env["CORPUS_INDEX_ENDPOINT"] ??= "http://localhost:7280";
process.env["CORPUS_INDEX_SEARCH_ENDPOINT"] ??= "http://localhost:7281";
process.env["GOTENBERG_URL"] ??= "http://localhost:3002";
process.env["GOTENBERG_USERNAME"] ??= "test";
process.env["GOTENBERG_PASSWORD"] ??= "test";
