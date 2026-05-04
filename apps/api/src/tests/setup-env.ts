process.env["DATABASE_URL"] ??=
  "postgres://stella:stella@localhost:5432/stella";
process.env["S3_ENDPOINT"] ??= "http://localhost:9000";
process.env["S3_BUCKET"] ??= "stella-test";
process.env["S3_REGION"] ??= "us-east-1";
process.env["AI_DEVTOOLS_ENABLED"] = "false";

process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["BETTER_AUTH_SECRET"] ??= "x".repeat(32);
process.env["BETTER_AUTH_URL"] ??= "http://localhost:3001";
process.env["EMAIL_PROVIDER"] ??= "smtp";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";
process.env["TRANSACTIONAL_EMAIL_FROM"] ??= "test@example.com";
process.env["FRONTEND_URL"] ??= "http://localhost:3000";
process.env["GOTENBERG_URL"] ??= "http://localhost:3002";
process.env["GOTENBERG_USERNAME"] ??= "test";
process.env["GOTENBERG_PASSWORD"] ??= "test";
