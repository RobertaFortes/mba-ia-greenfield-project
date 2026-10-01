# phase-03-videos — Progress

**Status:** in progress
**SIs:** 13/18 completed

### SI-03.1 — Dependencies, Configuration Namespaces and Environment Validation
- **Status:** completed
- **Tests:** 11/11 passing (env.validation.integration-spec.ts: 4 new tests for credentials, part-size minimum and defaults + 4 existing; swagger.config.spec.ts)
- **Observations:** Installed `@nestjs/bullmq@^12.0.0`, `bullmq@^6.3.11`, `@aws-sdk/client-s3@^3.1144.0`, `@aws-sdk/s3-request-presigner@^3.1144.0`. `S3_ACCESS_KEY`/`S3_SECRET_KEY` are now required, so the existing `requiredEnv` fixture of `env.validation.integration-spec.ts` gained dummy credentials. `.env.example` had an unquoted `MAIL_FROM` that broke `docker compose`; it is now quoted (minimal fix, needed to run Compose in this phase). Baseline before any Phase 03 change: `tsc` exit 0, e2e 52/52, unit+integration 147/148 — `src/database/migrations.integration-spec.ts` was already failing on the clean tree (concurrent `DROP TABLE … CASCADE` deadlock, plus a leftover `verification_tokens_type_enum`); fixed by dropping sequentially and dropping the enum type in `beforeAll`. `npm run lint` was already red on the clean tree (190 problems, 150 errors, all `no-unsafe-*` in Phase 01/02 files); Phase 03 code must add zero new lint errors, the pre-existing ones are out of scope (noted as a separate task).

### SI-03.2 — Object Storage, Redis and FFmpeg in Docker Compose
- **Status:** completed
- **Tests:** no tests (infra); verified manually — `storage` and `redis` reach `healthy`; `redis-cli ping` → `PONG`; signed `ListBuckets` from `nestjs-api` against `http://storage:9000` succeeds; `ffmpeg`/`ffprobe` 5.1.9 present; a key written to Redis survived `docker compose restart redis` (appendonly yes)
- **Observations:** `storage` uses `rustfs/rustfs:1.0.0` (TD-02 revision: MinIO community image archived); credentials map `S3_ACCESS_KEY`/`S3_SECRET_KEY` to `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY`; healthcheck is `curl -f http://localhost:9000/health` (curl exists in the image). Docker on this host needs `BUILDX_CONFIG` pointing to a writable dir because `~/.docker/buildx` is root-owned. The container does not receive `.env` as process env: code reads it through `dotenv/config` (jest) or Nest `ConfigModule`.

### SI-03.3 — StorageModule: S3 Clients, Bucket Bootstrap and Presigning
- **Status:** completed
- **Tests:** 8/8 passing (storage.module.spec.ts: 1 unit; storage.service.integration-spec.ts: 7 integration against the real RustFS — bucket bootstrap idempotence, 3-part multipart, abort, 206 range, Content-Disposition, expiry 403, internal presign)
- **Observations:** `ensureBucket` also tolerates `BucketAlreadyExists` (RustFS/other S3 servers may answer with it for an owned bucket). The download filename is sanitized (`"`, `\`, CR/LF replaced by `_`) before going into `ResponseContentDisposition`. The integration spec sets `S3_PUBLIC_ENDPOINT=http://storage:9000` because presigned URLs are fetched from inside the container.

### SI-03.4 — Video Entity, Status Enum, Public Id and Migration
- **Status:** completed
- **Tests:** 20/20 passing (video.entity.integration-spec.ts: 6; public-id.util.spec.ts: 14; videos.module.spec.ts: 1; migrations.integration-spec.ts: 3 — now covers `CreateVideos` apply, revert of the table and `videos_status_enum`, and revert of the auth migration)
- **Observations:** Migration generated with the TypeORM CLI (`1790840281098-CreateVideos.ts`, formatted with Prettier) and a second `migration:generate` reports no schema drift. `cleanAllTables` now deletes from `videos` first. `VideosModule` exports `TypeOrmModule`; services/controllers are added by later SIs. The pre-existing `Function` lint error in `create-test-data-source.ts` was left untouched (out of scope).

### SI-03.5 — Channel Lookup by User
- **Status:** completed
- **Tests:** 3 new integration tests passing in channels.service.integration-spec.ts (28/28 in `src/channels`)
- **Observations:** none

### SI-03.6 — Video Processing Queue Producer
- **Status:** completed
- **Tests:** 5/5 passing (video-queue.service.integration-spec.ts: 4 against real Redis — job name/data, jobId = video id, idempotent enqueue, 3 attempts + exponential 5000 ms, job survives a reopened queue; videos.module.spec.ts: 1, queue provider stubbed so the unit spec does no I/O)
- **Observations:** Deviation from TD-01: `@nestjs/bullmq@^11.0.5` installed instead of `^12.x` because v12 is ESM-only and Jest (CommonJS) cannot import it; `ioredis@^5` added because `bullmq@6` no longer bundles it. Recorded as a TD-01 revision and in `library-refs.md`. `BullModule.forRootAsync` reads `queueConfig`.

### SI-03.7 — Start Upload: Draft Pre-registration and Multipart Initialization
- **Status:** completed
- **Tests:** 50/50 passing — upload-parts.util.spec.ts: 6; videos.service.spec.ts: 10 (rejections, part URLs, public id retry bounded at 5, compensation incl. multipart abort); videos.service.integration-spec.ts: 4 (real DB + storage); test/videos-init-upload.e2e-spec.ts: 9 (all scenarios of `specs/videos-init-upload.plan.md`, incl. 10 GiB → 80 parts); plus the 21 earlier specs of `src/videos` still green
- **Observations:** `storage_key` extension comes from the validated content type (mp4/webm/mov/mkv), never from the user-supplied filename. The unique-violation detector lives in `src/common/database/pg-errors.ts` (the existing `ChannelsService` keeps its private copy; not touched to stay in scope). DTOs use explicit `@ApiProperty` because the exported OpenAPI document is generated under ts-node, where the Swagger CLI plugin does not run (the Phase 02 DTOs have empty schemas for that reason). E2E tests override the `videoConfig`/`storageConfig` providers (part size 5 MiB, public endpoint `http://storage:9000`) instead of env vars, so no module-registry tricks are needed; shared helper in `test/helpers/videos-e2e.helper.ts`. `npm run test:e2e` now passes `--runInBand` (as the project CLAUDE.md requires: the e2e suites share one database and the new suites clean all tables).

### SI-03.8 — Resume Upload: Session State and Pending Part URLs
- **Status:** completed
- **Tests:** unit — parse-video-public-id.pipe.spec.ts: 9, videos.service.spec.ts `getUploadSession`: 7; integration — videos.service.integration-spec.ts: 2 (2 of 3 parts → 2 uploaded + 1 pending with a working URL; foreign channel hidden); e2e — test/videos-upload-session.e2e-spec.ts: 6 (all scenarios of `specs/videos-upload-session.plan.md`)
- **Observations:** implemented together with SI-03.9 and SI-03.10 because the three routes share the `:publicId` pipe, the owner lookup (`findOwnedVideo`: user without channel and foreign video both answer `VIDEO_NOT_FOUND`) and the e2e helpers (`startUpload`, `putPart`, `uploadAllParts` in `test/helpers/videos-e2e.helper.ts`).

### SI-03.9 — Complete Upload and Enqueue Processing
- **Status:** completed
- **Tests:** unit — videos.service.spec.ts `completeUpload`: 20 (state guard, part coverage incl. duplicates/out-of-range, 4 storage rejection names, size mismatch, happy path, enqueue failure compensation); integration — 4 (happy path with the job in real Redis, second completion, wrong ETag keeps the draft, size mismatch fails the video and removes the object); e2e — test/videos-complete-upload.e2e-spec.ts: 8 (all scenarios of `specs/videos-complete-upload.plan.md`)
- **Observations:** a storage `InvalidPart`/`InvalidPartOrder`/`EntityTooSmall`/`NoSuchUpload` maps to `VIDEO_UPLOAD_INCOMPLETE` (verified against RustFS: a wrong ETag answers `InvalidPart`). Tests that read the queue call `queue.pause()` first so a `video-worker` container sharing the same Redis cannot consume the job before the assertion; they `obliterate` and `resume` afterwards.

### SI-03.10 — Abort Upload
- **Status:** completed
- **Tests:** unit — videos.service.spec.ts `abortUpload`: 7; integration — 2 (draft and multipart removed; repeat → not found); e2e — test/videos-abort-upload.e2e-spec.ts: 5 (all scenarios of `specs/videos-abort-upload.plan.md`)
- **Observations:** `NoSuchUpload` on the storage abort is tolerated (the draft is still removed); any other storage error keeps the draft so the client can retry.

### SI-03.11 — FFmpeg Service: Probe and Thumbnail Extraction
- **Status:** completed
- **Tests:** 21/21 passing — probe-parser.util.spec.ts: 8; thumbnail-time.util.spec.ts: 7; ffmpeg.service.integration-spec.ts: 6 (real `ffprobe`/`ffmpeg` over a presigned URL served by real storage: 3 s video metadata, silent video, non-media file, audio-only → `NoVideoStreamError`, JPEG thumbnail capped at 1280 px from a 1920x1080 source, timeout kill)
- **Observations:** `parseProbeOutput` also treats a "video" stream flagged `attached_pic` (cover art in audio files) as not a video stream. `ffprobe`/`ffmpeg` run through `child_process.spawn` with an argument array (no shell) and read the presigned URL directly with range reads, so nothing is downloaded. The timeout test points `ffprobe` at a local HTTP server that never answers and expects the rejection in under 5 s with a 1 s limit. `src/test/generate-test-video.ts` builds H.264/AAC MP4s from `lavfi` sources (the Debian `ffmpeg` in the image has `libx264`).

### SI-03.12 — Video Processing Service and Queue Consumer
- **Status:** completed
- **Tests:** 16/16 passing — video-processing.service.spec.ts: 9 (idempotent skip, state guard, missing video, no video stream → permanent, transient error propagates, thumbnail + metadata update, `processing_error` truncated to 500, only `processing` can fail); video-processing.service.integration-spec.ts: 4 (real DB, storage and FFmpeg: valid video → `ready` with metadata and a JPEG in storage, already-ready untouched, audio-only → permanent error, bounded `markFailed`); video.processor.integration-spec.ts: 3 (real Redis and worker: enqueue → `ready`; no video stream → `failed` after a single probe; transient failure retried 3 times and `failed` only after the last attempt)
- **Observations:** permanent failures (missing video, wrong state, no video stream) are raised as `PermanentProcessingError` and the processor converts them to BullMQ `UnrecoverableError`; `@OnWorkerEvent('failed')` marks the video failed only when attempts are exhausted or the error is unrecoverable. `markFailed` updates `WHERE status = 'processing'`, so a `ready` video is never downgraded. The success path saves the loaded entity (`Object.assign` + `save`) because `repo.update` rejects the `jsonb` `Record` type. `video.processor.integration-spec.ts` assumes it is the only consumer of the queue: stop the `video-worker` container while running it.

### SI-03.13 — Worker Entry Point and Compose Service
- **Status:** completed
- **Tests:** 2/2 passing — worker.module.spec.ts: 1 (compilation, queue stubbed); worker.module.integration-spec.ts: 1 (boots the application context via `NestFactory.createApplicationContext` and takes a real job to `ready`). Manual check: `docker compose up -d video-worker` compiles and logs `Consuming queue "video-processing" (no HTTP server)`.
- **Observations:** the shared bootstrap pieces were extracted so API and worker load the same env: `src/config/config-module.options.ts`, `src/database/typeorm.options.ts`, `src/queue/bull.options.ts` (`AppModule` now uses them; behavior unchanged). `WorkerModule` registers `User`, `Channel` and `Video` explicitly because `Video → Channel → User` relations need all three in the TypeORM metadata. Scripts `start:worker` and `start:worker:dev` added. Caveat: the API (`start:dev`) and the worker (`start:worker:dev`) both build into the shared `dist/` with `deleteOutDir`, so two watchers can briefly delete each other's output. With `video-worker` running, `video.processor.integration-spec.ts` is no longer the only queue consumer: stop `video-worker` before running it (`docker compose stop video-worker`).
