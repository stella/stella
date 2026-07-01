# Plan: Docker Setup for xberg Hybrid Search

## Context

Stella already has Docker infrastructure (PostgreSQL, MinIO, Valkey, Gotenberg). We need to extend it to support:
1. **pgvector extension** - For vector similarity search
2. **kreuzberg native binding** - For 96-format document extraction
3. **ONNX Runtime** - For embeddings and audio transcription

## Current Infrastructure

| Service | Image | Status |
|---------|-------|--------|
| PostgreSQL | `postgres:18.3` | ⚠️ No pgvector |
| MinIO | `minio/minio` | ✅ Ready |
| Valkey | `valkey/valkey:8-alpine` | ✅ Ready |
| Gotenberg | `gotenberg/gotenberg:8` | ✅ Ready |

## Changes Required

### 1. PostgreSQL with pgvector

**File:** `docker-compose.yml`

Replace `postgres:18.3` with `pgvector/pgvector:pg16`:

```yaml
postgres:
  profiles: [dev]
  image: pgvector/pgvector:pg16
  environment:
    POSTGRES_USER: postgres
    POSTGRES_PASSWORD: postgres
    POSTGRES_DB: stella
  ports:
    - "${STELLA_PG_HOST_PORT:-5432}:5432"
  volumes:
    - pgdata:/var/lib/postgresql/data
    - ./docker/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql
```

**File:** `docker/postgres/init.sql`

Add pgvector extension:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;
```

### 2. API Dockerfile with kreuzberg

**File:** `apps/api/Dockerfile`

Add system dependencies for kreuzberg:

```dockerfile
# Install kreuzberg system dependencies
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-deu \
    tesseract-ocr-fra \
    libheif-dev \
    && rm -rf /var/lib/apt/lists/*
```

Add kreuzberg native binding for Linux:

```dockerfile
# Install kreuzberg Linux native binding
RUN bun add @kreuzberg/node-linux-x64-gnu
```

### 3. Environment Variables

**File:** `.env.example` (new)

Add required environment variables:

```bash
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/stella

# MinIO/S3
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=stella

# Valkey/Redis
VALKEY_URL=redis://localhost:6379

# Kreuzberg
KREUZBERG_CACHE_DIR=/tmp/kreuzberg-cache
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `docker-compose.yml` | Modify | Switch to pgvector image |
| `docker/postgres/init.sql` | Modify | Add vector extension |
| `apps/api/Dockerfile` | Modify | Add kreuzberg dependencies |
| `.env.example` | Create | Document required env vars |

## Testing

1. Start Docker services:
   ```bash
   docker compose --profile dev up -d
   ```

2. Verify pgvector:
   ```bash
   docker compose exec postgres psql -U postgres -d stella -c "SELECT extname FROM pg_extension WHERE extname = 'vector';"
   ```

3. Run migrations:
   ```bash
   bun run --cwd apps/api db:push
   ```

4. Test kreuzberg extraction:
   ```bash
   bun run --cwd apps/api test xberg-integration
   ```

## Notes

- kreuzberg ONNX features require AVX2 CPU support (available in most modern x86_64 CPUs)
- For ARM64 (Apple Silicon), use `@kreuzberg/node-linux-arm64-gnu` instead
- ONNX Runtime models are downloaded on first use (~500MB)
- Consider using Docker BuildKit for faster builds with caching
