# phase-03-videos — Progress

**Status:** in progress
**SIs:** 2/18 completed

### SI-03.1 — Dependencies, Configuration Namespaces and Environment Validation
- **Status:** completed
- **Tests:** 11/11 passing (env.validation.integration-spec.ts: 4 new tests for credentials, part-size minimum and defaults + 4 existing; swagger.config.spec.ts)
- **Observations:** Installed `@nestjs/bullmq@^12.0.0`, `bullmq@^6.3.11`, `@aws-sdk/client-s3@^3.1144.0`, `@aws-sdk/s3-request-presigner@^3.1144.0`. `S3_ACCESS_KEY`/`S3_SECRET_KEY` are now required, so the existing `requiredEnv` fixture of `env.validation.integration-spec.ts` gained dummy credentials. `.env.example` had an unquoted `MAIL_FROM` that broke `docker compose`; it is now quoted (minimal fix, needed to run Compose in this phase). Baseline before any Phase 03 change: `tsc` exit 0, e2e 52/52, unit+integration 147/148 — `src/database/migrations.integration-spec.ts` was already failing on the clean tree (concurrent `DROP TABLE … CASCADE` deadlock, plus a leftover `verification_tokens_type_enum`); fixed by dropping sequentially and dropping the enum type in `beforeAll`. `npm run lint` was already red on the clean tree (190 problems, 150 errors, all `no-unsafe-*` in Phase 01/02 files); Phase 03 code must add zero new lint errors, the pre-existing ones are out of scope (noted as a separate task).

### SI-03.2 — Object Storage, Redis and FFmpeg in Docker Compose
- **Status:** completed
- **Tests:** no tests (infra); verified manually — `storage` and `redis` reach `healthy`; `redis-cli ping` → `PONG`; signed `ListBuckets` from `nestjs-api` against `http://storage:9000` succeeds; `ffmpeg`/`ffprobe` 5.1.9 present; a key written to Redis survived `docker compose restart redis` (appendonly yes)
- **Observations:** `storage` uses `rustfs/rustfs:1.0.0` (TD-02 revision: MinIO community image archived); credentials map `S3_ACCESS_KEY`/`S3_SECRET_KEY` to `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY`; healthcheck is `curl -f http://localhost:9000/health` (curl exists in the image). Docker on this host needs `BUILDX_CONFIG` pointing to a writable dir because `~/.docker/buildx` is root-owned. The container does not receive `.env` as process env: code reads it through `dotenv/config` (jest) or Nest `ConfigModule`.
