---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-30
scope_description: "Backend for video upload and processing: message queue, object-storage runtime/layout, 10GB resumable upload strategy, FFmpeg worker, unique public video URL, streaming/download delivery, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that receives the upload handshake, persists videos, publishes jobs, runs the worker (same codebase, separate container) and exposes streaming/download; also owns `compose.yaml` (new `storage`, `queue` and `video-worker` services).
- `next-frontend/` — the video UI is out of scope for this phase (backend challenge). The cross-layer decisions below (TD-03, TD-05, TD-06) define the HTTP contract a future frontend will consume; no frontend TD is opened here.

> **How this document was produced.** The options were researched against `docs/project-plan.md` (Fase 03 + "Pontos de Atenção"), the inherited decisions in `docs/decisions/` and the installed versions in `nestjs-project/package.json`. Library behavior was checked with context7 (BullMQ, `@nestjs/bullmq`, AWS SDK v3) and, where documentation was not enough, **empirically** (image pulls and an S3 multipart/presigned probe against the candidate storage servers — see TD-02). The `Decision:` fields record the choice made for this phase, following each recommendation.

## Inherited decisions (not reopened)

| Source | Inherited decision |
|---|---|
| phase-01 TD-01/02/03/04 | `@nestjs/config` + Joi validation + namespaced `registerAs`; config shared with the TypeORM CLI |
| phase-02 TD-06 | `class-validator` + `class-transformer` for DTOs |
| phase-02 TD-07 | Domain exception filter with `{ statusCode, error, message }` |
| phase-02 TD-08 | `@nestjs/throttler` for rate limiting |
| `docs/project-plan.md` §2 / `software-arch.mermaid` | API, Video Worker (FFmpeg), Database, Object Storage (S3/MinIO) and a Message Queue (`TBD`) as separate containers; frontend **streams from Object Storage** |
| `docs/project-plan.md` §4 | Upload of up to 10GB must not stall the system **and must be resumable after a connection failure**; processing must run in background; URLs must be short and never conflict |

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** "Serviço de processamento em segundo plano (filas)"

**Context:** The project plan leaves the queue as `TBD` in the architecture diagram. The API publishes a job when an upload completes and the Video Worker consumes it. It is the main stack decision of the phase. The stack today has PostgreSQL only (no Redis, no broker). The chosen technology must give retries with backoff, a way to observe the final failure (to mark the video as failed), and it must run as a real service in Docker Compose.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Jobs live in Redis; the API is the producer (`Queue.add`), the worker is a `Worker`/`@Processor`. Retries with fixed/exponential backoff (`attempts`, `backoff`), `jobId` for idempotent enqueue, `removeOnComplete/removeOnFail`, and a `failed` worker event fired on the final failure.
- **Pros:** Official NestJS integration (`@nestjs/bullmq`) with `@Processor`/`WorkerHost` and `@OnWorkerEvent`; retry/backoff built in; one small extra container (Redis); idiomatic for job queues in Node; Redis can also back future needs (throttler storage, caching).
- **Cons:** Introduces Redis as a new stateful dependency; at-least-once delivery, so the processor must be idempotent; Redis persistence (AOF) has to be enabled for durability.

### Option B: RabbitMQ (`amqplib` / `@nestjs/microservices` RMQ transport)
- A broker with exchanges/queues, acknowledgements and dead-letter exchanges. The API publishes a message; the worker consumes and acks.
- **Pros:** Real broker semantics, durable queues, native DLX, language-agnostic (a non-Node worker could consume).
- **Cons:** Retry with delay/backoff is not built in (needs TTL + dead-letter topology to emulate); heavier operational surface (management plugin, topology declaration); more custom code for the same job-queue behavior; no need for cross-language routing here.

### Option C: pg-boss (PostgreSQL as the queue)
- Uses the existing PostgreSQL with `SKIP LOCKED`; no new container.
- **Pros:** Zero new infrastructure; transactional enqueue with the video row (outbox-like consistency for free).
- **Cons:** The queue is not a separate service, while the architecture diagram and the phase's deliverables ("fila ... subindo via Docker") call for a queue container; adds polling load and vacuum churn to the primary database; no first-class NestJS module.

**Recommendation:** **Option A (BullMQ + Redis)** — it gives retry/backoff and a final-failure hook out of the box with an official NestJS module, matching the "fila real subindo no Compose" requirement with the least custom code; pg-boss would hide the queue inside the database and RabbitMQ would force us to hand-build retry topology for no routing benefit.

**Decision:** A (BullMQ + Redis)
**Libraries:** `@nestjs/bullmq@^12.x`, `bullmq@^6.x`

---

## TD-02: Object Storage Runtime, Client and Key Layout

**Scope:** Backend

**Capability:** "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** The storage is S3-compatible by definition (project plan: "S3 or MinIO"); what is open is *how to run and use it*. Two facts found during research change the plan: (1) **MinIO Community Edition is archived** — upstream stopped publishing Docker images and binaries in Oct/2025 and archived the repository in Apr/2026 — and (2) the AWS SDK v3 now adds checksum behaviors by default that break S3-compatible servers unless configured. Three things must be decided together because they are cited by `compose.yaml`, the Joi env schema and the storage service: which server image to run, which client library to use, and the bucket/key layout.

**Empirical verification (2026-09-30, on the development machine):**

| Candidate | `docker pull` | S3 probe (multipart + presigned parts + `ListParts` + `Range` → 206 + `response-content-disposition`) |
|---|---|---|
| `quay.io/minio/minio` (`latest`, `RELEASE.2025-09-07…`) | **fails** (`unauthorized`) | — |
| `minio/minio` (Docker Hub) | **fails** (repository does not exist) | — |
| `bitnamilegacy/minio:latest` (MinIO server 2025.5.24, frozen) | ok (297MB) | all steps passed |
| `rustfs/rustfs:latest` (active, published 2026-09) | ok (247MB) | all steps passed |

**Options:**

### Option A: `bitnamilegacy/minio` (frozen MinIO server)
- The real MinIO server, kept in Bitnami's legacy repository.
- **Pros:** Literally MinIO, the reference in the project plan; probe passed.
- **Cons:** Frozen at 2025.5.24 with no security fixes; the legacy repository is explicitly unmaintained and may disappear, which would make `docker compose up` unreproducible.

### Option B: RustFS (`rustfs/rustfs`, pinned tag)
- An actively maintained, S3-compatible object store (Apache-2.0) published as a Docker image; behaves as the S3 API for the operations this phase needs.
- **Pros:** Image is currently published and updated; probe passed on every operation the phase uses; the code targets the S3 API only, so moving to AWS S3 (or another server) is an environment change.
- **Cons:** Much younger project than MinIO; not the server named in the plan (must be justified in docs); S3 feature coverage beyond what we probe is less proven.

### Option C: Garage or SeaweedFS
- Other self-hosted S3-compatible servers.
- **Pros:** Active projects; Garage is very small (18MB image).
- **Cons:** Bucket/key and layout bootstrap needs extra tooling or an init container (`garage layout`, `weed shell`); S3 presigned/multipart behavior was not verified here; more setup for no functional gain in this phase.

**Recommendation:** **Option B (RustFS, pinned tag)** for the Compose `storage` service — the phase's hard requirement is a *reproducible* real storage in Compose, and MinIO's official images no longer exist while the frozen legacy copy can vanish; the code talks to the S3 API only (see below), so the server is replaceable. Option A remains a verified fallback (same probe passed) by changing the image name only.

**Client library and configuration (part of this decision):** use **AWS SDK v3** (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) over `minio-js`: it is the API of production S3, so dev→prod is only configuration. `S3Client` MUST be created with `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'` (default checksums otherwise break presigned URLs on S3-compatible servers).

**Two endpoints (part of this decision):** presigned URLs embed the host in the signature, so the URL handed to clients must be signed for the host the client can reach. Configure `S3_ENDPOINT` (Compose service name, e.g. `http://storage:9000`, used by API and worker) and `S3_PUBLIC_ENDPOINT` (host reachable by clients, e.g. `http://localhost:9000`, used **only** to sign URLs returned to clients). This is the single legitimate use of a non-service-name host in the project: it is a client-facing URL, not a service-to-service connection.

**Bucket and key layout (part of this decision):** one bucket (`S3_BUCKET`, default `streamtube`), created idempotently on API/worker startup; keys `videos/{videoId}/original.{ext}` and `videos/{videoId}/thumbnail.jpg` (`videoId` = internal UUID, never the public id). The bucket is private; nothing is served without a presigned URL.

**Decision:** B (RustFS pinned tag) + AWS SDK v3 with the checksum settings, two endpoints, single private bucket with the key layout above.
**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`
**Revisions:**
- 2026-09-30 — `S3_PUBLIC_ENDPOINT` is recorded as the single, explicit exception to the 'Compose service name, never `localhost`' rule: it is a client-facing URL used only to sign presigned URLs, while every service-to-service connection keeps `S3_ENDPOINT` (`http://storage:9000`). Rationale: presigned signatures embed the host the client will call, and a browser cannot resolve Compose service names (validation ICC-1).

---

## TD-03: Upload Strategy for Files up to 10GB

**Scope:** Cross-layer

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" and "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** `project-plan.md` requires 10GB uploads that neither stall the system nor force a restart after a connection failure. The upload handshake (init → send parts → complete) lives on both sides: the backend authorizes and signs, the client (future frontend) sends bytes. It also fixes when the draft row is created.

**Options:**

### Option A: Presigned S3 multipart upload (browser → storage directly)
- `POST` starts a multipart upload and pre-registers the draft; the API returns the `uploadId`, the part size and presigned `UploadPart` URLs; the client `PUT`s the parts straight to storage (parallel, retryable per part) and then calls a `complete` endpoint with the ETags. Resuming = `ListParts` for the video's `uploadId`.
- **Pros:** File bytes never traverse the API (no memory/CPU/bandwidth cost, API stays responsive); single S3 PUT is capped at 5GB but multipart supports 5TB (10GB needs multipart); per-part retry and resume after failure; verified in the TD-02 probe.
- **Cons:** More handshake endpoints; the client must handle part slicing and ETags; storage needs CORS exposing `ETag` for browsers; presigned URLs expire and may need re-issue.

### Option B: Stream the file through the API (multipart/form-data with Multer/busboy piping to S3)
- The client posts the file to the API, which pipes it to storage.
- **Pros:** Single request; simplest client; API can validate content while streaming.
- **Cons:** Ties up an API connection for the whole transfer (10GB at 50MB/s ≈ 3.5 minutes per upload), consumes API bandwidth and sockets, and a dropped connection restarts from zero — violates the "sem travar" and "retomar" requirements.

### Option C: tus resumable protocol (tusd or a Nest tus server)
- A dedicated resumable-upload protocol with its own server (tusd) that stores into S3.
- **Pros:** Standard resumable protocol with mature client libraries.
- **Cons:** Adds another server/protocol to run and secure, plus a hook to reconcile with our DB; duplicates what S3 multipart already gives natively for our S3-only storage.

**Recommendation:** **Option A (presigned multipart)** — it is the only option where the 10GB never touches the API and resume is native (`ListParts`), and it matches the architecture's "frontend ↔ storage" edge.

**Contract decisions (part of this decision):**
- **Size limit:** 10GiB (`10 * 1024^3` bytes) declared by the client in the init request (`sizeBytes`), validated by the API (`400` above the limit) and re-verified on complete with `HeadObject` (the real object size must match and stay ≤ limit).
- **Part size:** `max(VIDEO_UPLOAD_PART_SIZE_BYTES, ceil(sizeBytes / 10000))`, default `128MiB` (10GiB → 80 parts); S3 limits: part ≥ 5MiB (except last) and ≤ 10,000 parts. The API returns the part size and the presigned URL list; URL expiry `VIDEO_UPLOAD_URL_EXPIRATION_SECONDS` (default 3600).
- **Draft pre-registration:** the video row is created as `draft` by the init request (title required, description later phases), in the same request that creates the multipart upload; `uploadId` is stored on the row.
- **Endpoints (names fixed in the plan):** init, resume-info (`ListParts` + fresh presigned URLs for missing parts), complete, abort.
- **Accepted content types:** `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska` declared at init and stored as object `ContentType`; the worker validates real content with `ffprobe`.
- **Authorization:** only the authenticated owner of the channel can init/resume/complete/abort.

**Decision:** A (presigned multipart, direct to storage) with the contract above.
**Revisions:**
- 2026-09-30 — Init payload defined: required `filename`, `contentType` and `sizeBytes`; optional `title`, defaulting to the filename without extension (truncated to the column length). Rationale: the draft is pre-registered automatically when the upload starts and title editing belongs to Fase 04 (validation AMB-1).
- 2026-09-30 — Ownership resolves through the caller's channel: `ChannelsService.findByUserId(userId)` is added (Fase 02 delivered only `createChannel`); the video stores `channel_id` and every owner-only operation compares it with the caller's channel. Rationale: `JwtPayload.sub` is a user id while videos belong to channels (validation DG-1).

---

## TD-04: Video Processing Worker and FFmpeg Execution

**Scope:** Backend

**Capability:** "Processamento automático do vídeo após upload (extração de duração e metadados)" and "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The architecture defines a separate Video Worker (FFmpeg) that consumes jobs, reads/saves in storage and updates the database. We must decide how the worker is packaged, how it reaches a file that can be 10GB, and how it drives FFmpeg.

**Options:**

### Option A: Same codebase, separate container; FFmpeg via `child_process` reading the object through a presigned URL
- A second entry point (`worker.main.ts`, Nest standalone application context with the BullMQ `@Processor`) runs in its own Compose service from the same image. `ffprobe -show_format -show_streams -of json <presigned-internal-url>` extracts metadata and `ffmpeg -ss <t> -i <url> -frames:v 1` grabs a frame; both use HTTP range reads, so **the 10GB file is never downloaded to the worker disk**. The thumbnail is uploaded with `PutObject`.
- **Pros:** Reuses entities, repositories, config and Joi validation; independent scaling/restart of the worker; no local copy of huge files; no wrapper dependency (`spawn` with an argument array — no shell).
- **Cons:** FFmpeg must be installed in the image also used for tests (integration tests exercise the real processor); the API and worker images share size; depends on the storage supporting HTTP range (verified in TD-02).

### Option B: Worker downloads the file to a temp directory, then processes locally
- Same container topology, but the worker copies the object to disk first.
- **Pros:** Simplest FFmpeg invocation; handles inputs where random access over HTTP is slow.
- **Cons:** Needs disk ≥ the file size (10GB per concurrent job), doubles I/O, and the download time is pure overhead; poor fit for 10GB.

### Option C: A `fluent-ffmpeg` wrapper (instead of raw `spawn`)
- Use the popular wrapper for building commands and probing.
- **Pros:** Fluent API, less command-string handling.
- **Cons:** The package is **deprecated on npm** ("no longer supported"); adds a dependency to wrap two commands.

**Recommendation:** **Option A** — streaming from storage avoids 10GB local copies, and invoking `ffprobe`/`ffmpeg` directly with `child_process` avoids depending on a deprecated wrapper.

**Processing rules (part of this decision):**
- Metadata persisted: `durationSeconds`, `width`, `height`, `videoCodec`, `audioCodec`, `bitrate`, `formatName`, `fps` plus the raw probe summary in a `metadata` JSONB column; a file with no video stream is a permanent failure.
- Thumbnail: one JPEG frame at `min(1s, 10% of duration)` — guard for very short clips — scaled to a max width of 1280px, stored at `videos/{videoId}/thumbnail.jpg`.
- Job payload: `{ videoId, storageKey }`; the job id is the video id (idempotent enqueue) and the processor is idempotent (re-running overwrites the thumbnail and updates the same row).
- FFmpeg runs are bounded by a timeout (`VIDEO_PROCESSING_TIMEOUT_SECONDS`) and killed on expiry.

**Decision:** A (same codebase, separate worker container, `ffprobe`/`ffmpeg` via `spawn` over presigned internal URLs).

---

## TD-05: Unique Public URL Identifier

**Scope:** Cross-layer

**Capability:** "URL única por vídeo, sem conflito com outros vídeos"

**Context:** Each video needs a short, unique, non-enumerable identifier used in public URLs (`/videos/{publicId}/...`, and later the watch page). The internal primary key must not be the public URL. This is a contract between database (unique constraint) and API/frontend.

**Options:**

### Option A: Random 11-character URL-safe id (`crypto.randomBytes(8)` → base64url) + unique index
- 64 random bits encoded in 11 characters (YouTube-style), with a `UNIQUE` index; on the (astronomically unlikely) collision the insert is retried.
- **Pros:** Short, non-guessable, no new dependency (Node `crypto`); uniqueness is guaranteed by the database, not by probability alone.
- **Cons:** Not human-readable; needs a bounded retry on unique violation.

### Option B: UUID v4 as the public id
- **Pros:** Standard, collision-free in practice, no retry logic.
- **Cons:** 36 characters — not the "URL curta" the plan asks for (`project-plan.md` §4).

### Option C: Title-derived slug (+ suffix)
- **Pros:** Readable URLs.
- **Cons:** Titles change (later phases edit them) and collide, breaking the "nunca conflite" guarantee; needs suffix logic and redirects.

**Recommendation:** **Option A** — short and unique by construction (database constraint) with no dependency; UUID is too long for the plan's "URL curta" and slugs cannot stay stable when titles are edited in Phase 04.

**Decision:** A (11-char base64url public id, unique index, bounded retry on collision).

---

## TD-06: Streaming and Download Delivery (and Who Can Access)

**Scope:** Cross-layer

**Capability:** "Reprodução via streaming (sem necessidade de download completo)" and "Download do vídeo pelo usuário"

**Context:** A player must start playing without fetching the whole file, which requires HTTP range requests answered with `206 Partial Content`. The architecture diagram draws the frontend streaming **from Object Storage**. We must choose who serves the bytes and define access rules; the decision constrains the future player and the download button.

**Options:**

### Option A: API endpoints that redirect (302) to short-lived presigned GET URLs
- `GET /videos/{publicId}/stream` checks status/access and redirects to a presigned URL of the original object; the browser's `<video>` follows the redirect and the storage answers `Range` requests with `206` natively. `GET /videos/{publicId}/download` redirects to a presigned URL with `response-content-disposition=attachment`.
- **Pros:** API stays out of the data path (no bandwidth/socket cost for playback of 10GB files); range/206 handled natively by storage (verified in TD-02); matches the architecture edge "frontend → storage: Streams"; per-request authorization stays in the API.
- **Cons:** A public storage endpoint must be reachable by clients (`S3_PUBLIC_ENDPOINT`); one extra redirect hop; the presigned URL is bearer-like until it expires (kept short).

### Option B: API proxies the bytes and implements `Range` itself
- The API parses `Range`, calls `GetObject` with the range and pipes the stream, answering `206`.
- **Pros:** Storage never exposed; full control of headers.
- **Cons:** All playback traffic goes through the API (bandwidth, sockets, backpressure handling); range parsing/edge cases (suffix ranges, multi-range) become our code; contradicts the diagram.

### Option C: Public bucket / CDN-style direct URLs
- Make the bucket public-read and expose object URLs.
- **Pros:** Simplest to serve.
- **Cons:** No access control at all (drafts/failed videos or future unlisted rules become world-readable); URLs never expire.

**Recommendation:** **Option A** — the API decides *who* may fetch, storage serves the *bytes* with native range support; it follows the target architecture and keeps 10GB playback out of the API process.

**Access rules (part of this decision):**
- `stream`: public (anonymous users watch freely); only for videos in status `ready`. Non-existent or not-ready videos return `404` to non-owners (no state leak); the owner can also stream their own non-ready video only when the original object exists (`processing`), otherwise `404`.
- `download`: requires authentication (any logged-in user) and status `ready` — "Download do vídeo pelo usuário" is an authenticated capability, while watching is anonymous.
- Presigned GET expiry: `VIDEO_PLAYBACK_URL_EXPIRATION_SECONDS` (default 300).

**Decision:** A (redirect to presigned GET) with the access rules above.
**Revisions:**
- 2026-09-30 — Owner exception removed: `stream` redirects only for videos in status `ready`; any other status returns `404` to everyone. Rationale: the route is `@Public()`, so it has no authenticated principal, and no capability of the phase asks for previewing an unprocessed video (validation IC-1).
- 2026-09-30 — Throttle policy for the videos module: the global `ThrottlerGuard` (10 req/60s per IP, registered as `APP_GUARD` in `AuthModule`) stays; `stream` and `download` use `@SkipThrottle()` (the API only redirects, storage serves the bytes) and init / resume-info / complete / abort use an explicit `@Throttle({ default: { limit: 60, ttl: 60000 } })`. Rationale: a 10GiB upload legitimately refreshes part URLs many times and the inherited 10 req/min ceiling is a global side effect, not a per-domain policy (validation ICC-2).
- 2026-09-30 — The public metadata endpoint `GET /videos/:publicId` also uses `@SkipThrottle()` (read-only, one call per page view, no state change), completing the throttle policy of the videos module. Rationale: the inherited global ceiling of 10 req/60s per IP would throttle anonymous readers of a public endpoint; found while slicing the plan into Step Implementations.

---

## TD-07: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" and "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The status is the shared contract between API and worker and reflects the whole pipeline in the database. We must define states, transitions, what happens when processing fails, and how to avoid a video stuck because the queue publication failed after the database commit.

**Options:**

### Option A: `draft → processing → ready | failed`, retries in the queue, failure recorded by the worker
- `draft` (row created at init; upload in progress or pending), `processing` (upload completed and job enqueued), `ready` (metadata and thumbnail stored), `failed` (processing gave up). The job has `attempts: 3` with exponential backoff (5s base); on the **final** failure the worker's `failed` handler sets `failed` and stores `processingError` (truncated message). A failed video can be re-queued explicitly.
- **Pros:** Maps 1:1 to the plan's "rascunho → processando → pronto/erro"; retries absorb transient storage/probe errors; the failure reason is persisted; simple to query.
- **Cons:** Requires care at the boundary: enqueue happens after the DB commit.

### Option B: Add an `uploading` state between `draft` and `processing`
- **Pros:** Distinguishes "no bytes yet" from "waiting for complete".
- **Cons:** Both are "draft" from the product viewpoint (Phase 04 owns draft→publish); the extra state has no consumer in this phase and complicates transitions.

### Option C: Transactional outbox table polled by the worker (no direct enqueue)
- **Pros:** Enqueue is atomic with the status change.
- **Cons:** Extra table, a poller and duplicated retry logic when the queue already provides them; overkill for the current scale.

**Recommendation:** **Option A** — it is the smallest lifecycle that satisfies the plan; the enqueue-after-commit gap is closed with compensation instead of an outbox.

**Rules (part of this decision):**
- Allowed transitions: `draft → processing` (complete), `processing → ready` (worker success), `processing → failed` (worker final failure or enqueue failure), `failed → processing` (explicit reprocess), `draft → (deleted)` (abort). Anything else is a domain error (`409`).
- **Enqueue-failure compensation:** `complete` performs `CompleteMultipartUpload` + `HeadObject`, sets `processing` and commits, then enqueues; if the enqueue throws, the API sets the video to `failed` (`processingError = 'ENQUEUE_FAILED'`) and answers `503`, so the state is never silently stuck.
- **Idempotent worker:** the processor reads the row first and skips work if already `ready`; re-execution overwrites the thumbnail and rewrites the same columns.
- **Abandoned drafts:** `abort` deletes the draft and aborts the multipart upload; automatic cleanup of stale drafts is out of scope for this phase.

**Decision:** A (`draft → processing → ready | failed`, retries in queue, failure persisted, compensation on enqueue error).
**Revisions:**
- 2026-09-30 — Reprocess removed: `failed` is terminal in this phase (the user uploads again); the transition `failed → processing` and any reprocess endpoint are out of scope. Rationale: no capability of the phase asks for reprocessing and TD-03 defines no endpoint for it (validation IC-2).

---

## TD-08: Environment Variable Contract for Storage, Queue and Video Limits

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** The phase adds three new infrastructure services (storage, queue, worker) and several tunable limits. Each key is cited by at least three files that must stay consistent — the Joi schema (`env.validation.ts`), `.env.example`/`compose.yaml` and the `registerAs` config namespaces — so the canonical set of keys, which are required and which have defaults, is a cross-component contract (raised as MD-1 by `plan-validate`). It builds on the inherited config approach (`@nestjs/config` + Joi + namespaced `registerAs`); it does not reopen it.

**Options:**

### Option A: Three namespaced configs (`storage`, `queue`, `video`) with required credentials and Compose-friendly defaults
- `S3_ACCESS_KEY` and `S3_SECRET_KEY` are **required** (no default); every other key has a default that points to Compose service names. The same variables feed the storage server container in `compose.yaml`, so credentials are defined once.
- **Pros:** Fails fast when credentials are missing; consistent with the phase-01/02 pattern (one file per domain); values are documented in one place (`.env.example`); the worker reuses the same namespaces.
- **Cons:** Three more config files and a longer Joi schema.

### Option B: Reuse the standard AWS variable names (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`) read implicitly by the SDK
- **Pros:** Works with production S3 and the SDK default credential chain with no code.
- **Cons:** Configuration is implicit (not validated by Joi), mixes with real AWS credentials of a developer machine, and the endpoint/bucket keys would still need custom names — two conventions for one service.

### Option C: A single `videos` config with defaults for everything, including credentials
- **Pros:** Smallest amount of files; nothing to configure to boot.
- **Cons:** Default credentials in code are a security smell that tends to leak into production; mixes storage, queue and product limits in one namespace.

**Recommendation:** **Option A** — explicit, validated configuration in the same shape as the existing namespaces, with required credentials so a missing secret fails at boot instead of at first upload.

**Canonical keys (part of this decision):**

| Namespace | Key | Rule | Default |
|---|---|---|---|
| `storage` | `S3_ENDPOINT` | uri | `http://storage:9000` (service host) |
| `storage` | `S3_PUBLIC_ENDPOINT` | uri | `http://localhost:9000` (client-facing host used only to sign URLs) |
| `storage` | `S3_REGION` | string | `us-east-1` |
| `storage` | `S3_BUCKET` | string | `streamtube` |
| `storage` | `S3_ACCESS_KEY` | string | **required** |
| `storage` | `S3_SECRET_KEY` | string | **required** |
| `queue` | `REDIS_HOST` | string | `redis` |
| `queue` | `REDIS_PORT` | port | `6379` |
| `video` | `VIDEO_UPLOAD_PART_SIZE_BYTES` | number ≥ 5MiB | `134217728` (128MiB) |
| `video` | `VIDEO_UPLOAD_URL_EXPIRATION_SECONDS` | number | `3600` |
| `video` | `VIDEO_PLAYBACK_URL_EXPIRATION_SECONDS` | number | `300` |
| `video` | `VIDEO_PROCESSING_TIMEOUT_SECONDS` | number | `1800` |

The 10GiB size limit, the queue name and the job attempts/backoff are product/engineering constants defined in code (not environment). `.env.example` and `compose.yaml` carry development-only credential values.

**Decision:** A (three namespaced configs, required credentials, defaults on service names)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ + Redis | A |
| TD-02 | Backend | Object Storage Runtime, Client and Key Layout | RustFS pinned tag + AWS SDK v3, two endpoints, single bucket | B |
| TD-03 | Cross-layer | Upload Strategy for Files up to 10GB | Presigned S3 multipart, direct to storage | A |
| TD-04 | Backend | Video Processing Worker and FFmpeg Execution | Same codebase, separate container, `spawn` over presigned URLs | A |
| TD-05 | Cross-layer | Unique Public URL Identifier | 11-char base64url id + unique index | A |
| TD-06 | Cross-layer | Streaming and Download Delivery | 302 to presigned GET (public stream, authenticated download) | A |
| TD-07 | Backend | Video Status Lifecycle and Failure Handling | `draft → processing → ready \| failed`, retries in queue | A |
| TD-08 | Repo-wide | Environment Variable Contract for Storage, Queue and Video Limits | Three namespaced configs, required credentials | A |
