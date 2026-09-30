---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-30T17:28:51+0200"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-30T17:23:56+0200"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-30T17:28:51+0200"
  docs/project-plan.md: "2026-09-30T17:05:40+0200"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver resumable uploads of up to 10GB straight to object storage, automatic background processing (duration and metadata extraction plus thumbnail generation by an FFmpeg worker fed by a queue), a unique short public URL per video, streaming and download — with the new infrastructure (storage, queue, worker) running in Docker Compose.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces and Environment Validation

**Description:** Install the libraries decided for this phase, create the `storage`, `queue` and `video` configuration namespaces following the `registerAs` pattern, and extend the Joi schema with the canonical environment keys so a missing credential fails at boot.

**Technical actions:**

1. Install production dependencies in `nestjs-project`: `@nestjs/bullmq@^12.x`, `bullmq@^6.x`, `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
2. Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `S3_ENDPOINT` (default `http://storage:9000`), `S3_PUBLIC_ENDPOINT` (default `http://localhost:9000`), `S3_REGION` (default `us-east-1`), `S3_BUCKET` (default `streamtube`), `S3_ACCESS_KEY` and `S3_SECRET_KEY` (no defaults) (per `phase-03-videos/TD-08`)
3. Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (default `redis`) and `REDIS_PORT` (default `6379`); create `src/config/video.config.ts` — `registerAs('video', ...)` reading `VIDEO_UPLOAD_PART_SIZE_BYTES` (default `134217728`), `VIDEO_UPLOAD_URL_EXPIRATION_SECONDS` (default `3600`), `VIDEO_PLAYBACK_URL_EXPIRATION_SECONDS` (default `300`) and `VIDEO_PROCESSING_TIMEOUT_SECONDS` (default `1800`) (per `phase-03-videos/TD-08`)
4. Update `src/config/env.validation.ts` — add the keys to the Joi schema: `S3_ACCESS_KEY` and `S3_SECRET_KEY` required, `S3_ENDPOINT`/`S3_PUBLIC_ENDPOINT` as URIs, `REDIS_PORT` as port, `VIDEO_UPLOAD_PART_SIZE_BYTES` numeric with `min(5242880)` and the remaining numeric keys with the defaults above
5. Register the three configs in `ConfigModule.forRoot({ load: [...] })` in `src/app.module.ts` and add every new key to `.env.example` with development-only credential values (per `phase-03-videos/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (new keys) | Integration: required credentials, defaults, part-size minimum | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Booting with `S3_ACCESS_KEY` (or `S3_SECRET_KEY`) unset fails with a configuration validation error that names the missing key
- With only the two credentials set, the `storage` namespace resolves `S3_ENDPOINT=http://storage:9000`, `S3_REGION=us-east-1` and `S3_BUCKET=streamtube`, and the `queue` namespace resolves `REDIS_HOST=redis`, `REDIS_PORT=6379`
- The `video` namespace resolves `VIDEO_UPLOAD_PART_SIZE_BYTES=134217728`, `VIDEO_UPLOAD_URL_EXPIRATION_SECONDS=3600`, `VIDEO_PLAYBACK_URL_EXPIRATION_SECONDS=300` and `VIDEO_PROCESSING_TIMEOUT_SECONDS=1800` when unset
- `VIDEO_UPLOAD_PART_SIZE_BYTES` below `5242880` is rejected at boot
- A non-URI `S3_ENDPOINT` is rejected at boot

---

### SI-03.2 — Object Storage, Redis and FFmpeg in Docker Compose

**Description:** Add the storage server and the queue broker to `compose.yaml` and install FFmpeg in the development image, so the new infrastructure starts with the rest of the stack and is reachable by Compose service name.

**Technical actions:**

1. Add the `storage` service to `nestjs-project/compose.yaml` — image `rustfs/rustfs:1.0.0` (per `phase-03-videos/TD-02`), credentials from `S3_ACCESS_KEY`/`S3_SECRET_KEY` interpolated from `.env`, port `9000:9000`, a named volume for data, and a healthcheck that succeeds only when the S3 API answers
2. Add the `redis` service — image `redis:7-alpine` started with `redis-server --appendonly yes` for job durability (per `phase-03-videos/TD-01`, `library-refs.md`), a named volume and a `redis-cli ping` healthcheck
3. Update the `nestjs-api` service — `depends_on` `storage` and `redis` with `condition: service_healthy`
4. Update `nestjs-project/Dockerfile.dev` — install `ffmpeg` (which provides `ffmpeg` and `ffprobe`) alongside the existing packages (per `phase-03-videos/TD-04`) and rebuild the image

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1 _(the `S3_*` keys interpolated by Compose)_

**Acceptance criteria:**

- `docker compose up -d` starts `storage` and `redis` and both reach the healthy state (`docker compose ps`)
- `docker compose exec redis redis-cli ping` answers `PONG`
- A signed S3 request against `http://storage:9000` from inside `nestjs-api` succeeds with the configured credentials
- `docker compose exec nestjs-api ffmpeg -version` and `docker compose exec nestjs-api ffprobe -version` exit with code 0
- Stopping and restarting `redis` keeps previously enqueued jobs (append-only persistence is on)

---

### SI-03.3 — StorageModule: S3 Clients, Bucket Bootstrap and Presigning

**Description:** Provide the storage service used by the API and the worker: multipart operations, object operations and presigned URLs, with two S3 clients (service endpoint and client-facing endpoint) and an idempotent bucket bootstrap.

**Technical actions:**

1. Create `src/storage/storage.constants.ts` — injection tokens `S3_CLIENT` (built with `S3_ENDPOINT`) and `S3_PRESIGN_CLIENT` (built with `S3_PUBLIC_ENDPOINT`), used only to sign client-facing URLs (per `phase-03-videos/TD-02`)
2. Create `src/storage/storage.module.ts` — `StorageModule` with providers that build both `S3Client`s from `storageConfig` using `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'` (per `phase-03-videos/TD-02`, `library-refs.md`); exports `StorageService`
3. Create `src/storage/storage.service.ts` — multipart methods: `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber, expiresIn)`, `listParts(key, uploadId)` (follows `PartNumberMarker` pagination), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)`
4. In the same service — object methods: `headObject(key)`, `putObject(key, body, contentType)`, `deleteObject(key)`, `presignGet(key, expiresIn, { downloadFilename? })` with the public-endpoint client (adds `ResponseContentDisposition: attachment; filename="..."` when requested) and `presignInternalGet(key, expiresIn)` with the service-endpoint client, for the worker
5. `onModuleInit` — `ensureBucket()` sends `CreateBucketCommand` and treats `BucketAlreadyOwnedByYou` as success (per `phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration: real storage — bucket bootstrap, multipart flow, presigned URLs, range read | `src/storage/storage.service.integration-spec.ts` |

The integration spec overrides `S3_PUBLIC_ENDPOINT` with the service host (`http://storage:9000`) because presigned URLs are fetched from inside the container.

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- Starting the module creates the configured bucket; starting it again does not fail
- A multipart upload of three parts (two of 5MiB and one smaller) sent with `PUT` to the presigned part URLs completes into an object whose size equals the sum of the parts
- `listParts` returns every uploaded part with its `part_number`, `size` and `ETag`
- `abortMultipartUpload` removes the upload: a later `listParts` for the same `uploadId` fails
- A presigned GET URL answers `Range: bytes=0-99` with status `206`, a `Content-Range` header and exactly 100 bytes
- A presigned GET URL created with a download filename answers with `Content-Disposition: attachment; filename="<name>"`
- A presigned URL used after its expiration is rejected with status `403`
- `presignInternalGet` returns a URL that uses the service host and is readable from inside the container

---

### SI-03.4 — Video Entity, Status Enum, Public Id and Migration

**Description:** Persist videos: the `Video` entity with its status enum, the public id generator and the migration that creates the table linked to channels.

**Technical actions:**

1. Create `src/videos/entities/video-status.enum.ts` — `VideoStatus` with `DRAFT = 'draft'`, `PROCESSING = 'processing'`, `READY = 'ready'`, `FAILED = 'failed'` (per `phase-03-videos/TD-07`)
2. Create `src/videos/entities/video.entity.ts` — `Video` mapped to `videos` exactly as in `### Data Model` (`snake_case` properties, `size_bytes` bigint with a numeric transformer, `metadata` jsonb, `@ManyToOne(() => Channel)` on `channel_id`)
3. Create `src/videos/public-id.util.ts` — `generatePublicId()` returning `crypto.randomBytes(8).toString('base64url')` (11 characters) and `isValidPublicId(value)` (per `phase-03-videos/TD-05`)
4. Generate the migration `src/database/migrations/<timestamp>-CreateVideos.ts` with `npm run migration:generate` — enum type, `videos` table, unique index on `public_id`, index on `channel_id`, foreign key to `channels(id)`
5. Create `src/videos/videos.module.ts` — `VideosModule` with `TypeOrmModule.forFeature([Video])` and `ChannelsModule` imported; register `VideosModule` in `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: defaults, constraints, enum, foreign key, bigint transformer, jsonb | `src/videos/entities/video.entity.integration-spec.ts` |
| `generatePublicId` / `isValidPublicId` | Unit: length, charset, uniqueness sample, validation | `src/videos/public-id.util.spec.ts` |
| `CreateVideos` migration | Integration: apply and revert | `src/database/migrations.integration-spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** none _(uses the existing `channels` table from Fase 02)_

**Acceptance criteria:**

- After running migrations the `videos` table exists with a unique index on `public_id`, an index on `channel_id` and a foreign key to `channels`
- Reverting the migration drops the table and the `videos_status_enum` type
- Inserting a video without an explicit status stores `draft`
- Inserting two videos with the same `public_id` violates the unique constraint
- Inserting a video with a `channel_id` that does not exist violates the foreign key
- `size_bytes` of `10737418240` is stored and read back as the number `10737418240`
- `generatePublicId()` returns 11 characters, all in `[A-Za-z0-9_-]`

---

### SI-03.5 — Channel Lookup by User

**Description:** Give `ChannelsService` the lookup the videos module needs to resolve the caller's channel, since Fase 02 delivered only channel creation.

**Technical actions:**

1. Add `findByUserId(userId: string): Promise<Channel | null>` to `src/channels/channels.service.ts` — returns the channel whose `user_id` matches, or `null` (per `phase-03-videos/TD-03` revision, validation issue DG-1)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ChannelsService.findByUserId` | Integration: DB contract | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `findByUserId` for a user that has a channel returns that channel
- `findByUserId` for a user id with no channel returns `null`
- `findByUserId` never returns a channel that belongs to a different user

---

### SI-03.6 — Video Processing Queue Producer

**Description:** Wire BullMQ to the Redis service and expose the producer the API uses to publish the processing job, with the queue constants and job options decided for the phase.

**Technical actions:**

1. Create `src/videos/videos.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process'`, `VIDEO_JOB_OPTIONS` (`attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: 100`), `MAX_VIDEO_SIZE_BYTES = 10 * 1024 ** 3` and `ALLOWED_VIDEO_CONTENT_TYPES` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`, `phase-03-videos/TD-07`)
2. Create `src/videos/video-processing.types.ts` — `VideoProcessingJobData { videoId: string; storageKey: string }` (per `### Events/Messages`)
3. Add `BullModule.forRootAsync` to `src/app.module.ts` reading `queueConfig` (`connection: { host, port }`) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`)
4. Register the queue in `VideosModule` — `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE, defaultJobOptions: VIDEO_JOB_OPTIONS })`
5. Create `src/videos/video-queue.service.ts` — `VideoQueueService.enqueue(videoId, storageKey)` calling `queue.add(PROCESS_VIDEO_JOB, { videoId, storageKey }, { jobId: videoId })`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoQueueService` | Integration: real Redis — job data, jobId, options, idempotent enqueue | `src/videos/video-queue.service.integration-spec.ts` |

**Dependencies:** SI-03.1, SI-03.2, SI-03.4

**Acceptance criteria:**

- `enqueue(videoId, storageKey)` creates a job named `process` in the `video-processing` queue carrying `{ videoId, storageKey }`
- The created job's id equals the video id
- Enqueuing the same video id twice results in a single job
- The job is configured with 3 attempts and exponential backoff starting at 5000 ms
- After the queue is closed and reopened the job is still present in Redis

---

### SI-03.7 — Start Upload: Draft Pre-registration and Multipart Initialization

**Description:** Implement `POST /videos`: validate the declared file, pre-register the video as a `draft` in the caller's channel, open the S3 multipart upload and return the presigned part URLs so the client sends the file directly to storage.

**Route:** POST /videos
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated (any logged-in user with a channel)

**Technical actions:**

1. Add `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `ChannelNotFoundException` (`CHANNEL_NOT_FOUND`, 404), `VideoFileTooLargeException` (`VIDEO_FILE_TOO_LARGE`, 400) and `VideoUnsupportedContentTypeException` (`VIDEO_UNSUPPORTED_CONTENT_TYPE`, 400) to `src/common/exceptions/domain.exception.ts` (per `### Error Catalog`)
2. Create `src/videos/dto/init-upload.dto.ts` — `InitUploadDto` with `filename` (`@IsString`, length 1–255), `content_type` (`@IsString`), `size_bytes` (`@IsInt @Min(1)`), optional `title` (`@IsString`, length 1–200) (per `### API Contracts → Validation Rules`)
3. Create `src/videos/upload-parts.util.ts` — `calculatePartPlan(sizeBytes, configuredPartSize)` returning `{ partSizeBytes: max(configured, ceil(size / 10000)), totalParts }` (per `phase-03-videos/TD-03`)
4. Create `src/videos/videos.service.ts` — `VideosService.initUpload(userId, dto)`: resolve the channel with `ChannelsService.findByUserId` (else `ChannelNotFoundException`); reject `size_bytes` above `MAX_VIDEO_SIZE_BYTES` and unsupported content types; compute the part plan; insert the `draft` with a generated `public_id`, retrying on a unique violation up to a bounded number of times, `storage_key = videos/{id}/original.{ext}` and the title default; call `createMultipartUpload`; persist `upload_id`, `part_size_bytes`, `total_parts`; presign every part URL; if the storage call fails after the insert, delete the draft and rethrow (per `phase-03-videos/TD-03`, `phase-03-videos/TD-05`, `phase-03-videos/TD-07`)
5. Create `src/videos/videos.controller.ts` — `VideosController` (`@Controller('videos')`, `@ApiTags('videos')`) with `@Post()` returning 201, `@ApiBearerAuth('access-token')`, `@ApiOperation`/`@ApiResponse` for every status in `### API Contracts` using `ApiErrorEnvelope`, `@CurrentUser()` for the user id, and `@Throttle({ default: { limit: 60, ttl: 60000 } })` (per `phase-03-videos/TD-06` revision)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `calculatePartPlan` | Unit: 10GiB → 80 parts at 128MiB, one part for small files, cap at 10000 parts, boundaries | `src/videos/upload-parts.util.spec.ts` |
| `VideosService.initUpload` | Unit: size and type rejection, missing channel, public id retry, compensation on storage failure (mock repo/storage) | `src/videos/videos.service.spec.ts` |
| `VideosService.initUpload` | Integration: real DB and storage — draft persisted, multipart opened, part URL accepts bytes | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**

- `POST /videos` with a valid body returns `201` with `id`, `public_id` (11 characters), `status: "draft"`, `title`, `upload_id`, `part_size_bytes`, `total_parts`, `url_expires_in_seconds` and a `parts` array with one `{ part_number, url }` per part
- Omitting `title` stores and returns the filename without its extension
- `size_bytes: 10737418240` returns `total_parts: 80` with the default part size; `size_bytes: 10737418241` returns `400` with `VIDEO_FILE_TOO_LARGE`
- `content_type: "video/avi"` returns `400` with `VIDEO_UNSUPPORTED_CONTENT_TYPE`
- A body with extra unknown properties or an invalid `size_bytes` returns `400` with `VALIDATION_ERROR`
- A request without a bearer token returns `401`
- The created row is a `draft` owned by the caller's channel; a `PUT` of bytes to a returned part URL answers `200` with an `ETag` header
- Two `POST /videos` calls never produce the same `public_id`

---

### SI-03.8 — Resume Upload: Session State and Pending Part URLs

**Description:** Implement `GET /videos/:publicId/upload`, which lets the owner resume an interrupted upload (and poll the video status): it lists the parts already stored and returns fresh presigned URLs for the missing ones.

**Route:** GET /videos/:publicId/upload
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated (channel owner)

**Technical actions:**

1. Create `src/videos/parse-video-public-id.pipe.ts` — a pipe that validates `:publicId` with `isValidPublicId` and throws `VideoNotFoundException` otherwise; reused by every `:publicId` route (per `phase-03-videos/TD-05`)
2. Create `src/videos/dto/upload-session.response.ts` — `UploadSessionResponse` with `@ApiProperty` documenting the fields in `### API Contracts` (`uploaded_parts`, `pending_parts`, nullable upload fields)
3. Add `VideosService.getUploadSession(userId, publicId)`: load the video by `public_id` owned by the caller's channel (else `VideoNotFoundException`); when `draft`, read all stored parts with `listParts`, derive the missing part numbers from `total_parts` and presign URLs for them; for any other status return the status with empty arrays and null upload fields
4. Add the `@Get(':publicId/upload')` handler to `VideosController` with Swagger decorators, `@ApiBearerAuth('access-token')` and `@Throttle({ default: { limit: 60, ttl: 60000 } })`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ParseVideoPublicIdPipe` | Unit: accepts valid ids, rejects malformed with `VIDEO_NOT_FOUND` | `src/videos/parse-video-public-id.pipe.spec.ts` |
| `VideosService.getUploadSession` | Unit: non-owner and non-draft branches (mock repo/storage) | `src/videos/videos.service.spec.ts` |
| `VideosService.getUploadSession` | Integration: real storage — 2 of 3 parts uploaded → 2 uploaded, 1 pending with a working URL | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- After uploading two of three parts, `GET /videos/:publicId/upload` returns `200` with `uploaded_parts` listing those two (`part_number`, `size_bytes`, `etag`) and `pending_parts` containing the third with a URL that accepts the bytes
- A video that is not `draft` returns `200` with its `status`, empty `uploaded_parts` and `pending_parts`, and `upload_id: null`; a `failed` video also returns its `processing_error`
- A video owned by another channel returns `404` with `VIDEO_NOT_FOUND`, identical to an unknown id
- A malformed `publicId` returns `404` with `VIDEO_NOT_FOUND`
- A request without a bearer token returns `401`

---

### SI-03.9 — Complete Upload and Enqueue Processing

**Description:** Implement `POST /videos/:publicId/upload/complete`: finish the multipart upload, verify the stored size, move the video to `processing` and publish the processing job, compensating when the queue is unavailable.

**Route:** POST /videos/:publicId/upload/complete
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated (channel owner)

**Technical actions:**

1. Add `VideoInvalidStateException` (`VIDEO_INVALID_STATE`, 409), `VideoUploadIncompleteException` (`VIDEO_UPLOAD_INCOMPLETE`, 400), `VideoSizeMismatchException` (`VIDEO_SIZE_MISMATCH`, 400) and `VideoQueueUnavailableException` (`VIDEO_QUEUE_UNAVAILABLE`, 503) to `src/common/exceptions/domain.exception.ts`
2. Create `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto` with `parts` validated as a non-empty array (max 10000) of nested `{ part_number: integer 1–10000, etag: non-empty string }`
3. Add `VideosService.completeUpload(userId, publicId, dto)`: ownership check; require `draft` (else `VIDEO_INVALID_STATE`); require the submitted `part_number`s to be exactly 1..`total_parts` (else `VIDEO_UPLOAD_INCOMPLETE`); `completeMultipartUpload` (a storage `InvalidPart` maps to `VIDEO_UPLOAD_INCOMPLETE`); `headObject` and compare with `size_bytes` — on mismatch delete the object, set `failed` with `processing_error = 'SIZE_MISMATCH'` and throw `VIDEO_SIZE_MISMATCH`; otherwise set `processing` and `upload_id = null` in a committed update
4. In the same method, after the commit call `VideoQueueService.enqueue(video.id, video.storage_key)`; if it throws, set `failed` with `processing_error = 'ENQUEUE_FAILED'` and throw `VIDEO_QUEUE_UNAVAILABLE` (per `phase-03-videos/TD-07`)
5. Add the `@Post(':publicId/upload/complete')` handler to `VideosController` — `@HttpCode(202)`, Swagger decorators, `@ApiBearerAuth('access-token')`, `@Throttle({ default: { limit: 60, ttl: 60000 } })`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: state check, part coverage, size mismatch, enqueue failure compensation (mock storage/queue) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: real DB, storage and Redis — happy path enqueues the job; size mismatch marks `failed` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6, SI-03.7

**Acceptance criteria:**

- After uploading every part, `POST /videos/:publicId/upload/complete` with the parts and ETags returns `202` with `status: "processing"`
- After completion the `video-processing` queue holds a job whose id equals the video id and whose data is `{ videoId, storageKey }`
- Calling complete a second time returns `409` with `VIDEO_INVALID_STATE`
- Submitting fewer parts than `total_parts` returns `400` with `VIDEO_UPLOAD_INCOMPLETE` and the video stays `draft`
- When the stored object size differs from the declared `size_bytes`, the call returns `400` with `VIDEO_SIZE_MISMATCH`, the object is removed and the video becomes `failed`
- When the queue is unreachable the call returns `503` with `VIDEO_QUEUE_UNAVAILABLE` and the video becomes `failed` with `processing_error` `ENQUEUE_FAILED`
- A video owned by another channel returns `404` with `VIDEO_NOT_FOUND`
- A body with an empty `parts` array returns `400` with `VALIDATION_ERROR`

---

### SI-03.10 — Abort Upload

**Description:** Implement `DELETE /videos/:publicId/upload`, which cancels an in-progress upload: it aborts the multipart upload in storage and removes the draft.

**Route:** DELETE /videos/:publicId/upload
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated (channel owner)

**Technical actions:**

1. Add `VideosService.abortUpload(userId, publicId)`: ownership check; require `draft` (else `VIDEO_INVALID_STATE`); `abortMultipartUpload`; delete the row
2. Add the `@Delete(':publicId/upload')` handler to `VideosController` — `@HttpCode(204)` (no body schema), Swagger decorators, `@ApiBearerAuth('access-token')`, `@Throttle({ default: { limit: 60, ttl: 60000 } })`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.abortUpload` | Unit: state and ownership branches (mock repo/storage) | `src/videos/videos.service.spec.ts` |
| `VideosService.abortUpload` | Integration: real DB and storage — draft removed and multipart upload gone | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- `DELETE /videos/:publicId/upload` on a `draft` owned by the caller returns `204`, deletes the `videos` row and the multipart upload no longer exists in storage
- Repeating the call returns `404` with `VIDEO_NOT_FOUND`
- A video that is not `draft` returns `409` with `VIDEO_INVALID_STATE` and is left untouched
- A video owned by another channel returns `404` with `VIDEO_NOT_FOUND`
- A request without a bearer token returns `401`

---

### SI-03.11 — FFmpeg Service: Probe and Thumbnail Extraction

**Description:** Provide the wrapper around `ffprobe` and `ffmpeg` that the worker uses to extract metadata and one thumbnail frame directly from a presigned URL, without downloading the file.

**Technical actions:**

1. Create `src/videos/processing/probe-parser.util.ts` — `parseProbeOutput(json)` returning `{ durationSeconds, width, height, videoCodec, audioCodec, bitrate, formatName, fps, raw }`; throws `NoVideoStreamError` when the file has no video stream (per `phase-03-videos/TD-04`)
2. Create `src/videos/processing/thumbnail-time.util.ts` — `calculateThumbnailTime(durationSeconds)` returning `min(1, 0.1 * durationSeconds)`, guarding zero, negative and `NaN` durations (per `phase-03-videos/TD-04`)
3. Create `src/videos/processing/ffmpeg.service.ts` — `FfmpegService.probe(url)` running `ffprobe -v error -print_format json -show_format -show_streams <url>` via `child_process.spawn` with an argument array (no shell), bounded by `VIDEO_PROCESSING_TIMEOUT_SECONDS` and killing the process on expiry (per `phase-03-videos/TD-04`)
4. In the same service — `extractThumbnail(url, atSeconds): Promise<Buffer>` running `ffmpeg -ss <t> -i <url> -frames:v 1` with a scale filter capping the width at 1280px, writing one JPEG frame to stdout, with the same timeout handling
5. Create `src/test/generate-test-video.ts` — helper that generates a short valid MP4 with `ffmpeg -f lavfi -i testsrc` for integration tests

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseProbeOutput` | Unit: fixtures with/without audio, no video stream | `src/videos/processing/probe-parser.util.spec.ts` |
| `calculateThumbnailTime` | Unit: short clip, long clip, invalid duration | `src/videos/processing/thumbnail-time.util.spec.ts` |
| `FfmpegService` | Integration: real `ffprobe`/`ffmpeg` over a presigned URL served by real storage | `src/videos/processing/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `probe` of a generated 3-second video returns a duration close to 3 seconds and the generated `width`, `height`, `videoCodec` and `fps`
- `probe` of a file that is not media rejects with an error
- `probe` of a file with only an audio stream rejects with `NoVideoStreamError`
- `extractThumbnail` returns a JPEG (starts with bytes `FF D8`, ends with `FF D9`) whose width is at most 1280
- The thumbnail time is `0.05` seconds for a 0.5-second video and `1` second for a video of 60 seconds or more
- A run that exceeds the configured timeout is killed and the call rejects

---

### SI-03.12 — Video Processing Service and Queue Consumer

**Description:** Implement the processing logic and the BullMQ consumer: probe the uploaded file, generate and store the thumbnail, mark the video `ready`, and mark it `failed` on the final failure.

**Technical actions:**

1. Create `src/videos/processing/video-processing.service.ts` — `process(videoId)`: load the video; return without changes when it is already `ready`; require status `processing`; obtain `presignInternalGet(storage_key)`; `probe`; `extractThumbnail` at `calculateThumbnailTime`; `putObject` to `videos/{id}/thumbnail.jpg`; update the row with the metadata columns, `thumbnail_key`, `status = ready` and `processed_at` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-07`)
2. In the same service — `markFailed(videoId, reason)` setting `status = failed` and a `processing_error` truncated to 500 characters
3. Create `src/videos/processing/video.processor.ts` — `VideoProcessor` (`@Processor(VIDEO_PROCESSING_QUEUE)` extending `WorkerHost`) whose `process(job)` delegates to the service and converts `NoVideoStreamError` and a missing video into BullMQ `UnrecoverableError`; `@OnWorkerEvent('failed')` calls `markFailed` only when `job.attemptsMade >= job.opts.attempts` or the error is unrecoverable (per `phase-03-videos/TD-07`, `library-refs.md`)
4. Create `src/videos/processing/video-processing.module.ts` — `VideoProcessingModule` importing `StorageModule`, `TypeOrmModule.forFeature([Video])` and the video queue registration, providing `FfmpegService`, `VideoProcessingService` and `VideoProcessor`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: idempotent skip, state guard, `processing_error` truncation (mock repo/ffmpeg/storage) | `src/videos/processing/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration: real DB, storage and FFmpeg — valid video becomes `ready` with metadata and thumbnail object | `src/videos/processing/video-processing.service.integration-spec.ts` |
| `VideoProcessor` | Integration: real Redis and worker — enqueue → `ready`; invalid file → `failed` | `src/videos/processing/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.4, SI-03.6, SI-03.11

**Acceptance criteria:**

- Enqueuing a `processing` video whose object is a valid MP4 leaves it `ready` with `duration_seconds`, `width`, `height`, `video_codec`, `fps`, `metadata`, `thumbnail_key` and `processed_at` set, and the JPEG thumbnail exists in storage at `videos/{id}/thumbnail.jpg`
- Processing a video that is already `ready` changes nothing
- An object with no video stream leaves the video `failed` with a non-empty `processing_error` and is not retried
- A transient failure is retried up to 3 attempts and the video becomes `failed` only after the last attempt
- `processing_error` never exceeds 500 characters

---

### SI-03.13 — Worker Entry Point and Compose Service

**Description:** Run the consumer as its own process and container from the same codebase, so the API is never blocked by video processing.

**Technical actions:**

1. Create `src/database/typeorm.options.ts` — the shared `TypeOrmModule.forRootAsync` factory extracted from `AppModule` (same `databaseConfig`, `autoLoadEntities: true`, `synchronize: false`) and use it in `AppModule` (per the inherited config convention)
2. Create `src/worker/worker.module.ts` — `WorkerModule` importing `ConfigModule.forRoot` (same `load` list and Joi schema), the shared TypeORM options, `BullModule.forRootAsync` and `VideoProcessingModule`
3. Create `src/worker/worker.main.ts` — `NestFactory.createApplicationContext(WorkerModule)` with `enableShutdownHooks()` and a startup log line naming the queue (per `phase-03-videos/TD-04`, `library-refs.md`)
4. Add scripts to `package.json` — `start:worker` (`node dist/worker/worker.main`) and `start:worker:dev` (`nest start --watch --entryFile worker/worker.main`)
5. Add the `video-worker` service to `compose.yaml` — same build and volume as `nestjs-api`, command `npm run start:worker:dev`, `depends_on` `db`, `storage` and `redis` with `condition: service_healthy`, `restart: unless-stopped`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test | `src/worker/worker.module.spec.ts` |
| `WorkerModule` | Integration: boots the application context and processes a real job end to end | `src/worker/worker.module.integration-spec.ts` |

**Dependencies:** SI-03.12

**Acceptance criteria:**

- `docker compose up -d` leaves `video-worker` running and its logs show it consuming the `video-processing` queue
- A job enqueued while the API server is not running is processed by `video-worker` and the video becomes `ready`
- The API process does not consume jobs: with `video-worker` stopped, a job enqueued by `POST /videos/:publicId/upload/complete` stays waiting in the queue until the worker starts
- Sending `SIGTERM` to `video-worker` closes the workers and the process exits with code 0

---

### SI-03.14 — Public Video Metadata

**Description:** Implement `GET /videos/:publicId`, the public read of a ready video with its extracted metadata and a short-lived thumbnail URL.

**Route:** GET /videos/:publicId
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Anonymous

**Technical actions:**

1. Create `src/videos/dto/public-video.response.ts` — `PublicVideoResponse` with `@ApiProperty` documenting the fields in `### API Contracts` (`GET /videos/:publicId`)
2. Add `VideosService.getPublicVideo(publicId)`: load by `public_id`; only `ready` videos are visible (else `VideoNotFoundException`); build the response with `presignGet(thumbnail_key, VIDEO_PLAYBACK_URL_EXPIRATION_SECONDS)` as `thumbnail_url` (per `phase-03-videos/TD-06`)
3. Add the `@Get(':publicId')` handler to `VideosController` — `@Public()`, `@SkipThrottle()`, `ParseVideoPublicIdPipe`, Swagger decorators without `@ApiBearerAuth` (per `phase-03-videos/TD-06` revisions)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPublicVideo` | Unit: only `ready` visible, thumbnail URL built (mock repo/storage) | `src/videos/videos.service.spec.ts` |
| `VideosService.getPublicVideo` | Integration: real DB and storage — thumbnail URL is fetchable | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4, SI-03.8, SI-03.12

**Acceptance criteria:**

- `GET /videos/:publicId` for a `ready` video without any token returns `200` with `public_id`, `title`, `duration_seconds`, `width`, `height`, `video_codec`, `bitrate`, `fps`, `thumbnail_url`, `created_at` and `processed_at`
- Fetching the returned `thumbnail_url` answers `200` with `Content-Type: image/jpeg`
- A video in `draft`, `processing` or `failed` returns `404` with `VIDEO_NOT_FOUND`, the same response as an unknown or malformed id
- Ten consecutive requests from the same client are all answered (no throttling)

---

### SI-03.15 — Streaming

**Description:** Implement `GET /videos/:publicId/stream`: the API authorizes and redirects to a short-lived presigned URL, and storage serves the bytes with range support, so playback never needs the whole file and never passes through the API.

**Route:** GET /videos/:publicId/stream
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Anonymous

**Technical actions:**

1. Add `VideosService.getStreamUrl(publicId)`: only `ready` videos are visible (else `VideoNotFoundException`); returns `presignGet(storage_key, VIDEO_PLAYBACK_URL_EXPIRATION_SECONDS)` (per `phase-03-videos/TD-06`)
2. Add the `@Get(':publicId/stream')` handler to `VideosController` — `@Public()`, `@SkipThrottle()`, `ParseVideoPublicIdPipe`, answering `302` through `@Redirect()` with the URL from the service, Swagger decorators without `@ApiBearerAuth` (per `phase-03-videos/TD-06` revisions)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getStreamUrl` | Unit: visibility rule (mock repo/storage) | `src/videos/videos.service.spec.ts` |
| `VideosService.getStreamUrl` | Integration: real storage — range read answers 206 without transferring the whole file | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.14

**Acceptance criteria:**

- `GET /videos/:publicId/stream` for a `ready` video without a token returns `302` with a `Location` header
- A request to that `Location` with `Range: bytes=0-99` returns `206` with `Content-Range` and exactly 100 bytes
- `stream` of a video in `draft`, `processing` or `failed`, or of an unknown or malformed id, returns `404` with `VIDEO_NOT_FOUND`
- Fifteen consecutive `stream` requests from the same client all return `302` (no throttling)

---

### SI-03.16 — Download

**Description:** Implement `GET /videos/:publicId/download`: an authenticated user is redirected to a short-lived presigned URL that makes the browser save the original file.

**Route:** GET /videos/:publicId/download
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated (any logged-in user)

**Technical actions:**

1. Create `src/videos/download-filename.util.ts` — `toSafeDownloadFilename(name)` stripping quotes, control characters and path separators, falling back to `video` when the result is empty
2. Add `VideosService.getDownloadUrl(publicId)`: same visibility rule as streaming; returns `presignGet` with `downloadFilename` set to `toSafeDownloadFilename(original_filename)` (per `phase-03-videos/TD-06`)
3. Add the `@Get(':publicId/download')` handler to `VideosController` — authenticated (`@ApiBearerAuth('access-token')`), `ParseVideoPublicIdPipe`, `@SkipThrottle()`, answering `302` with the download URL (per `phase-03-videos/TD-06` revisions)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `toSafeDownloadFilename` | Unit: quotes, control characters, path separators, empty input | `src/videos/download-filename.util.spec.ts` |
| `VideosService.getDownloadUrl` | Unit: visibility rule and filename option (mock repo/storage) | `src/videos/videos.service.spec.ts` |
| `VideosService.getDownloadUrl` | Integration: real storage — the target answers with an attachment disposition | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.15

**Acceptance criteria:**

- `GET /videos/:publicId/download` without a token returns `401`
- `GET /videos/:publicId/download` with a valid token returns `302`, and the `Location` target answers with `Content-Disposition: attachment; filename="<original filename>"`
- `download` of a video in `draft`, `processing` or `failed`, or of an unknown or malformed id, returns `404` with `VIDEO_NOT_FOUND`
- An original filename containing quotes or path separators produces a header whose filename has them removed

---

### SI-03.17 — End-to-End Upload and Processing Flow

**Description:** Prove the whole phase in one scenario using the real infrastructure: multipart upload straight to storage, completion, background processing by the worker, then metadata, streaming and download.

**Technical actions:**

1. Create `test/support/upload-video.ts` — helper that registers and logs in a user, calls `POST /videos`, sends each part with `PUT` to its presigned URL and returns the collected ETags
2. Create `test/videos-pipeline.e2e-spec.ts` — boots the API (`AppModule`) and the processing module in the same Nest test context with `S3_PUBLIC_ENDPOINT` set to the service host, runs the scenarios below and polls `GET /videos/:publicId/upload` until the status settles

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Video pipeline (init → parts → complete → worker → metadata/stream/download) | E2E: real Postgres, Redis, storage and FFmpeg | `test/videos-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.9, SI-03.10, SI-03.12, SI-03.14, SI-03.15, SI-03.16

**Acceptance criteria:**

- A user uploads a generated MP4 in three parts, completes the upload, and within 60 seconds `GET /videos/:publicId/upload` reports `ready`
- `GET /videos/:publicId` then returns the extracted duration, dimensions and a fetchable thumbnail
- `GET /videos/:publicId/stream` redirects to a URL that answers a `Range` request with `206`
- `GET /videos/:publicId/download` (authenticated) redirects to a URL that answers with `Content-Disposition: attachment`
- Completing an upload whose object is not a valid video ends with the video `failed` and a `processing_error`, and the public metadata route answers `404`
- Another user asking for the first user's upload session receives `404 VIDEO_NOT_FOUND`
- Aborting a fresh draft removes it and its multipart upload

---

### SI-03.18 — OpenAPI Export and AI Documentation

**Description:** Make the exported API contract and the project's AI guidance reflect the real state of the code after the phase: the new endpoints, the queue and storage technologies, the worker and the documented `S3_PUBLIC_ENDPOINT` exception.

**Technical actions:**

1. Regenerate `nestjs-project/openapi.json` with `npm run openapi:export` so it contains the video endpoints (per `openapi-docs-nestjs/TD-02`)
2. Update `nestjs-project/CLAUDE.md` — the new Compose services (`storage`, `redis`, `video-worker`), the `start:worker`/`start:worker:dev` scripts, the required `.env` keys (`S3_ACCESS_KEY`, `S3_SECRET_KEY`) and the test note that suites set `S3_PUBLIC_ENDPOINT` to the service host
3. Update the root `CLAUDE.md` — Message Queue is BullMQ + Redis, Object Storage is RustFS (S3-compatible, MinIO images no longer published), the `videos`/`storage`/worker modules and endpoints, and the recorded exception that `S3_PUBLIC_ENDPOINT` is a client-facing host (per `phase-03-videos/TD-02` revision)
4. Update `docs/diagrams/software-arch.mermaid` — replace the queue's `TBD` technology with `BullMQ + Redis` and the storage technology with `RustFS (S3)` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Exported OpenAPI document | Integration: contains the seven video operations | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.13, SI-03.16, SI-03.17

**Acceptance criteria:**

- `openapi.json` lists `POST /videos`, `GET /videos/{publicId}/upload`, `POST /videos/{publicId}/upload/complete`, `DELETE /videos/{publicId}/upload`, `GET /videos/{publicId}`, `GET /videos/{publicId}/stream` and `GET /videos/{publicId}/download`
- Both `CLAUDE.md` files describe only files, services, scripts and endpoints that exist in the repository
- The architecture diagram no longer says the queue technology is `TBD`

---

## Technical Specifications

### Data Model

#### Video

Table `videos` (entity `Video` in `src/videos/entities/video.entity.ts`; column/property names are `snake_case`, following `Channel`/`User`).

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| public_id | varchar(11) | unique, not null — random 11-char base64url identifier used in every public URL (per `phase-03-videos/TD-05`) |
| channel_id | uuid | not null, FK → `channels.id` (the owner of the video) |
| title | varchar(200) | not null — defaults to the original filename without extension (per `phase-03-videos/TD-03` revision) |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` (per `phase-03-videos/TD-07`) |
| original_filename | varchar(255) | not null |
| content_type | varchar(100) | not null — one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska` |
| size_bytes | bigint | not null, > 0 and ≤ 10737418240 (10GiB); mapped to `number` with a transformer |
| storage_key | varchar(255) | not null — `videos/{id}/original.{ext}` (per `phase-03-videos/TD-02`) |
| thumbnail_key | varchar(255) | null — `videos/{id}/thumbnail.jpg`, set when the worker finishes |
| upload_id | varchar(255) | null — S3 multipart `UploadId`; set on init, cleared on complete/abort |
| part_size_bytes | integer | null — part size chosen at init (needed to resume) |
| total_parts | integer | null — number of parts chosen at init |
| duration_seconds | double precision | null — set by the worker |
| width | integer | null — set by the worker |
| height | integer | null — set by the worker |
| video_codec | varchar(50) | null — set by the worker |
| audio_codec | varchar(50) | null — `null` when the file has no audio stream |
| bitrate | double precision | null — bits per second |
| format_name | varchar(100) | null |
| fps | double precision | null |
| metadata | jsonb | null — raw probe summary |
| processing_error | varchar(500) | null — truncated failure reason (per `phase-03-videos/TD-07`) |
| processed_at | timestamp | null — set when status becomes `ready` |
| created_at | timestamp | not null, default now() |
| updated_at | timestamp | not null, default now(), updated on save |

**Relations:** `Video` many-to-one `Channel` through `channel_id` (the `channels` table is not modified).
**Indexes:** unique on `public_id`; index on `channel_id`.

**Status lifecycle (per `phase-03-videos/TD-07`):**

| From | To | Trigger |
|------|----|---------|
| (none) | `draft` | `POST /videos` |
| `draft` | `processing` | `POST /videos/:publicId/upload/complete` succeeds and the job is enqueued |
| `draft` | (row deleted) | `DELETE /videos/:publicId/upload` |
| `draft` | `failed` | upload size mismatch on complete (`processing_error = 'SIZE_MISMATCH'`) |
| `processing` | `ready` | worker finishes probe + thumbnail |
| `processing` | `failed` | worker final failure, or enqueue failure (`processing_error = 'ENQUEUE_FAILED'`) |

`failed` is terminal in this phase (per `phase-03-videos/TD-07` revision); any other transition is a `VIDEO_INVALID_STATE` domain error.

### API Contracts

All routes live under `@Controller('videos')` in `src/videos/videos.controller.ts`. JSON field names are `snake_case` (consistent with `access_token`/`refresh_token`). Every route is keyed by `:publicId` (the 11-char public id); a malformed or unknown id answers `404 VIDEO_NOT_FOUND`. Errors use the inherited `{ statusCode, error, message }` shape; DTO failures answer `400` with `error: "VALIDATION_ERROR"`.

#### POST /videos (SI-03.7)

**Request headers:**
- Authorization: Bearer <access token>
- Content-Type: application/json

**Request body:**
- filename: string, required — 1 to 255 characters
- content_type: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`
- size_bytes: integer, required — ≥ 1 and ≤ 10737418240 (10GiB)
- title: string, optional — 1 to 200 characters; defaults to `filename` without extension

**Response 201:**
- id: string (uuid)
- public_id: string (11 characters, `[A-Za-z0-9_-]`)
- status: string — `draft`
- title: string
- upload_id: string
- part_size_bytes: number
- total_parts: number
- url_expires_in_seconds: number — `VIDEO_UPLOAD_URL_EXPIRATION_SECONDS`
- parts: array of `{ part_number: number, url: string }` — one presigned `PUT` URL per part, numbered 1..`total_parts`

**Error responses:**
- 400 VIDEO_FILE_TOO_LARGE: when `size_bytes` exceeds 10737418240
- 400 VIDEO_UNSUPPORTED_CONTENT_TYPE: when `content_type` is not in the accepted list
- 400 VALIDATION_ERROR: when the body fails DTO validation
- 401 Unauthorized: missing or invalid access token
- 404 CHANNEL_NOT_FOUND: when the authenticated user has no channel
- 429 Too Many Requests: more than 60 requests per minute from the same IP

---

#### GET /videos/:publicId/upload (SI-03.8)

**Request headers:**
- Authorization: Bearer <access token>

**Response 200:**
- id: string (uuid)
- public_id: string
- status: string — `draft`, `processing`, `ready` or `failed`
- title: string
- processing_error: string | null
- upload_id: string | null — only while `draft`
- part_size_bytes: number | null — only while `draft`
- total_parts: number | null — only while `draft`
- url_expires_in_seconds: number | null — only while `draft`
- uploaded_parts: array of `{ part_number: number, size_bytes: number, etag: string }` — empty unless `draft`
- pending_parts: array of `{ part_number: number, url: string }` — presigned URLs for parts not yet uploaded; empty unless `draft`

**Error responses:**
- 401 Unauthorized: missing or invalid access token
- 404 VIDEO_NOT_FOUND: unknown or malformed `publicId`, or the video belongs to another channel

---

#### POST /videos/:publicId/upload/complete (SI-03.9)

**Request headers:**
- Authorization: Bearer <access token>
- Content-Type: application/json

**Request body:**
- parts: array, required — non-empty, at most 10000 items of `{ part_number: integer (1–10000), etag: string, required, non-empty }`

**Response 202:**
- id: string (uuid)
- public_id: string
- status: string — `processing`

**Error responses:**
- 400 VIDEO_UPLOAD_INCOMPLETE: when the submitted `part_number`s are not exactly 1..`total_parts`, or storage rejects a part/ETag
- 400 VIDEO_SIZE_MISMATCH: when the stored object size differs from `size_bytes` (the video becomes `failed`)
- 400 VALIDATION_ERROR: when the body fails DTO validation
- 401 Unauthorized: missing or invalid access token
- 404 VIDEO_NOT_FOUND: unknown or malformed `publicId`, or the video belongs to another channel
- 409 VIDEO_INVALID_STATE: when the video is not in `draft`
- 503 VIDEO_QUEUE_UNAVAILABLE: when the job could not be enqueued (the video becomes `failed` with `ENQUEUE_FAILED`)

---

#### DELETE /videos/:publicId/upload (SI-03.10)

**Request headers:**
- Authorization: Bearer <access token>

**Response 204:** No content.

**Error responses:**
- 401 Unauthorized: missing or invalid access token
- 404 VIDEO_NOT_FOUND: unknown or malformed `publicId`, or the video belongs to another channel
- 409 VIDEO_INVALID_STATE: when the video is not in `draft`

---

#### GET /videos/:publicId (SI-03.14)

Public route (`@Public()`, `@SkipThrottle()`); only `ready` videos are visible.

**Response 200:**
- id: string (uuid)
- public_id: string
- title: string
- status: string — `ready`
- duration_seconds: number
- width: number
- height: number
- video_codec: string
- audio_codec: string | null
- bitrate: number
- format_name: string
- fps: number
- thumbnail_url: string — presigned GET URL, valid `VIDEO_PLAYBACK_URL_EXPIRATION_SECONDS`
- created_at: string (ISO 8601)
- processed_at: string (ISO 8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown or malformed `publicId`, or the video is not `ready`

---

#### GET /videos/:publicId/stream (SI-03.15)

Public route (`@Public()`, `@SkipThrottle()`); the API only authorizes and redirects, storage serves the bytes with native range support (per `phase-03-videos/TD-06`).

**Response 302:** `Location` = presigned GET URL of the original object, valid `VIDEO_PLAYBACK_URL_EXPIRATION_SECONDS`. A request to that URL with `Range: bytes=a-b` answers `206 Partial Content`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown or malformed `publicId`, or the video is not `ready`

---

#### GET /videos/:publicId/download (SI-03.16)

Authenticated route (any logged-in user, `@SkipThrottle()`).

**Request headers:**
- Authorization: Bearer <access token>

**Response 302:** `Location` = presigned GET URL with `response-content-disposition=attachment; filename="<original_filename>"`, valid `VIDEO_PLAYBACK_URL_EXPIRATION_SECONDS`.

**Error responses:**
- 401 Unauthorized: missing or invalid access token
- 404 VIDEO_NOT_FOUND: unknown or malformed `publicId`, or the video is not `ready`

---

#### Validation Rules — Videos

- `filename`: required string, 1–255 characters
- `content_type`: required, one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`
- `size_bytes`: required integer ≥ 1; values above 10737418240 are rejected by the service with `VIDEO_FILE_TOO_LARGE`
- `title`: optional string, 1–200 characters
- `parts[].part_number`: integer 1–10000, unique; the set must equal 1..`total_parts`
- `parts[].etag`: required non-empty string
- `:publicId`: exactly 11 characters from `[A-Za-z0-9_-]`; anything else answers `404 VIDEO_NOT_FOUND`
- Part size: `max(VIDEO_UPLOAD_PART_SIZE_BYTES, ceil(size_bytes / 10000))`, with `VIDEO_UPLOAD_PART_SIZE_BYTES ≥ 5242880` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-08`)

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner | Notes |
|----------|-----------|---------------|-------|-------|
| POST /videos | ✗ | ✓ | ✓ | The video is created in the caller's channel |
| GET /videos/:publicId/upload | ✗ | ✗ | ✓ | A non-owner receives `404 VIDEO_NOT_FOUND` (no state leak) |
| POST /videos/:publicId/upload/complete | ✗ | ✗ | ✓ | A non-owner receives `404 VIDEO_NOT_FOUND` |
| DELETE /videos/:publicId/upload | ✗ | ✗ | ✓ | A non-owner receives `404 VIDEO_NOT_FOUND` |
| GET /videos/:publicId | ✓ | ✓ | ✓ | `ready` videos only; any other status is `404` for everyone |
| GET /videos/:publicId/stream | ✓ | ✓ | ✓ | `ready` videos only (per `phase-03-videos/TD-06` revision) |
| GET /videos/:publicId/download | ✗ | ✓ | ✓ | `ready` videos only; any logged-in user may download |

Ownership is resolved through the caller's channel: `JwtPayload.sub` (user id) → `ChannelsService.findByUserId` → compare with `videos.channel_id` (per `phase-03-videos/TD-03` revision).

### Error Catalog

Error response format is inherited from `phase-02-auth` (`{ statusCode, error, message }`, `error` = domain code).

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown or malformed `publicId`; video owned by another channel on owner-only routes; video not `ready` on public routes |
| CHANNEL_NOT_FOUND | 404 | Channel not found | `POST /videos` for an authenticated user without a channel |
| VIDEO_FILE_TOO_LARGE | 400 | Video file exceeds the 10GiB limit | `POST /videos` with `size_bytes` above 10737418240 |
| VIDEO_UNSUPPORTED_CONTENT_TYPE | 400 | Unsupported video content type | `POST /videos` with a `content_type` outside the accepted list |
| VIDEO_UPLOAD_INCOMPLETE | 400 | Upload is incomplete | `POST /videos/:publicId/upload/complete` with parts that do not cover 1..`total_parts` or that storage rejects |
| VIDEO_SIZE_MISMATCH | 400 | Uploaded file size does not match the declared size | `POST /videos/:publicId/upload/complete` when `HeadObject` size differs from `size_bytes` |
| VIDEO_INVALID_STATE | 409 | Video is not in a valid state for this operation | complete/abort on a video that is not `draft` |
| VIDEO_QUEUE_UNAVAILABLE | 503 | Video processing queue is unavailable | `POST /videos/:publicId/upload/complete` when enqueueing the job fails |

Rate limiting answers `429` through the inherited `@nestjs/throttler` guard; authentication failures answer `401` through the inherited `JwtAuthGuard`.

### Events/Messages

#### video-processing (job `process`)

**Payload:**

```json
{ "videoId": "uuid", "storageKey": "videos/{videoId}/original.{ext}" }
```

**Producer:** `VideoQueueService` in the API (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`)
**Consumer:** `VideoProcessor` running in the `video-worker` container (per `phase-03-videos/TD-04`)
**Trigger:** `POST /videos/:publicId/upload/complete` after `CompleteMultipartUpload` succeeded and the row is committed as `processing`
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`) — `jobId = videoId` makes the enqueue idempotent and the processor skips a video that is already `ready` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-07`)
**Job options:** `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: 100` (per `phase-03-videos/TD-07`)
**Outcomes:** success → `videos.status = ready` with metadata and `thumbnail_key`; final failure (last attempt, or an unrecoverable error such as a file with no video stream) → `videos.status = failed` with `processing_error`

---

## Dependency Map

```
SI-03.1 (root)
└── SI-03.2
    ├── SI-03.3
    │   └── SI-03.11 (also needs SI-03.2)
    └── SI-03.6 (also needs SI-03.4)
SI-03.4 (root)
SI-03.5 (root)

SI-03.3 + SI-03.4 + SI-03.5
└── SI-03.7
    ├── SI-03.8
    ├── SI-03.9 (also needs SI-03.6)
    └── SI-03.10

SI-03.4 + SI-03.6 + SI-03.11
└── SI-03.12
    ├── SI-03.13
    └── SI-03.14 (also needs SI-03.4, SI-03.8)
        └── SI-03.15
            └── SI-03.16

SI-03.9 + SI-03.10 + SI-03.12 + SI-03.14 + SI-03.15 + SI-03.16
└── SI-03.17
    └── SI-03.18 (also needs SI-03.13, SI-03.16)
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.4, SI-03.5 (parallel) → SI-03.3, SI-03.6 (parallel) → SI-03.7, SI-03.11 → SI-03.8, SI-03.9, SI-03.10, SI-03.12 → SI-03.13, SI-03.14 → SI-03.15 → SI-03.16 → SI-03.17 → SI-03.18

---

## Deliverables

- [ ] SI-03.1 — Dependencies, Configuration Namespaces and Environment Validation
- [ ] SI-03.2 — Object Storage, Redis and FFmpeg in Docker Compose
- [ ] SI-03.3 — StorageModule: S3 Clients, Bucket Bootstrap and Presigning
- [ ] SI-03.4 — Video Entity, Status Enum, Public Id and Migration
- [ ] SI-03.5 — Channel Lookup by User
- [ ] SI-03.6 — Video Processing Queue Producer
- [ ] SI-03.7 — Start Upload: Draft Pre-registration and Multipart Initialization
- [ ] SI-03.8 — Resume Upload: Session State and Pending Part URLs
- [ ] SI-03.9 — Complete Upload and Enqueue Processing
- [ ] SI-03.10 — Abort Upload
- [ ] SI-03.11 — FFmpeg Service: Probe and Thumbnail Extraction
- [ ] SI-03.12 — Video Processing Service and Queue Consumer
- [ ] SI-03.13 — Worker Entry Point and Compose Service
- [ ] SI-03.14 — Public Video Metadata
- [ ] SI-03.15 — Streaming
- [ ] SI-03.16 — Download
- [ ] SI-03.17 — End-to-End Upload and Processing Flow
- [ ] SI-03.18 — OpenAPI Export and AI Documentation

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
- [ ] `docker compose up -d` starts `db`, `mailpit`, `storage`, `redis` and `video-worker` and all report running/healthy
