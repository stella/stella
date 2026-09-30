# @stll/redis-config

Shared Redis connection settings for Bun and ioredis adapters.

`redisConnectionConfig` returns a typed result for configuration validation and preserves the configured certificate policy by default.
`REDIS_CONNECTION_ENFORCED=true` requires service credentials, a TLS URL,
`REDIS_TLS_CA_PEM` (PEM contents), and `REDIS_TLS_SERVER_NAME`.
Credentials can be provided through `REDIS_USERNAME` and `REDIS_PASSWORD` or the URL.

The package has no connection or environment side effects.
