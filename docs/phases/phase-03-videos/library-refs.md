---
libs:
  "@nestjs/bullmq":
    version: "^12.x"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-09-30T17:23:56+0200"
  bullmq:
    version: "^6.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-30T17:23:56+0200"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-30T17:23:56+0200"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-30T17:23:56+0200"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-30T17:22:54+0200"
---

# phase-03-videos — Library References

Distilled docs for the libraries decided in this phase (`phase-03-videos/TD-01` and `TD-02`). Pulled via Context7; installed-version compatibility checked against `npm view` (`@nestjs/bullmq@12.0.0` — installed as `@nestjs/bullmq@^11.0.5` instead because v12 is ESM-only and breaks Jest/CommonJS, see TD-01 revision — declares peers `@nestjs/core ^10 || ^11 || ^12` and `bullmq ^3 – ^6`; `bullmq@6.3.10`; `@aws-sdk/*@3.1143.0`, Node ≥ 20 — the project runs Node 25). Re-fetch when the underlying TD changes.

## @nestjs/bullmq

**Source:** `/nestjs/bull` (Context7, High reputation). Maps to `phase-03-videos/TD-01` Decision A.

### Module wiring

```typescript
import { BullModule } from '@nestjs/bullmq';

// AppModule — shared Redis connection, from the `queue` config namespace (TD-08)
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
  }),
});

// VideosModule — the queue used by the producer (API) and the processor (worker)
BullModule.registerQueue({
  name: 'video-processing',
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: 100,
  },
});
```

`registerQueue` also attaches an `onApplicationShutdown` hook that closes workers and the queue. `registerQueueAsync` accepts `useFactory`/`inject` for per-queue configuration.

### Producer (API)

```typescript
@Injectable()
export class VideoQueueService {
  constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}

  enqueue(videoId: string, storageKey: string) {
    // jobId = videoId => idempotent enqueue (a duplicate jobId is ignored)
    return this.queue.add('process', { videoId, storageKey }, { jobId: videoId });
  }
}
```

### Consumer (worker)

```typescript
@Processor('video-processing', { concurrency: 1 })
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string; storageKey: string }>) {
    // throwing lets BullMQ retry according to attempts/backoff
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error) {
    // fired on EVERY failed attempt: only the last one is final
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) { /* mark the video as failed */ }
  }
}
```

- The class MUST extend `WorkerHost` and implement `process(job)`; `@OnWorkerEvent` requires the class to be annotated with `@Processor`.
- `worker` getter throws before `onModuleInit`; do not touch `this.worker` earlier.
- Worker entry point: `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server); call `app.enableShutdownHooks()` so workers close cleanly.

## bullmq

**Source:** `/taskforcesh/bullmq` (Context7, High reputation, benchmark 87). Maps to `phase-03-videos/TD-01`.

- **Retries/backoff:** `attempts` + `backoff: { type: 'exponential' | 'fixed', delay }`. A job is retried while `attemptsMade + 1 < attempts` and the error is not an `UnrecoverableError`; exponential doubles the delay each attempt (5s → 10s → 20s). Throw `UnrecoverableError` for permanent failures (e.g. a file with no video stream) to skip remaining attempts.
- **Idempotent enqueue:** adding a job whose `jobId` already exists is ignored. Caution: with `removeOnComplete`/`removeOnFail` a removed job no longer counts, so the same id can be enqueued again.
- **Cleanup:** `removeOnComplete: true` and `removeOnFail: <count>` keep Redis small while retaining recent failures for inspection.
- **Connection:** when the worker is given an IORedis **instance**, it MUST be created with `maxRetriesPerRequest: null`; passing a plain options object (`{ host, port }`), as `@nestjs/bullmq` does, lets BullMQ manage it.
- **Events:** `failed` is emitted per failed attempt (worker-local event); use `job.attemptsMade`/`job.opts.attempts` to detect the final one.
- **Delivery semantics:** at-least-once — the processor must be idempotent (see `TD-04`/`TD-07`).
- **Durability:** Redis must be started with append-only persistence for jobs to survive a restart (`redis-server --appendonly yes` in Compose).

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7, High reputation) plus an **empirical probe** against the candidate storage servers (2026-09-30). Maps to `phase-03-videos/TD-02` and `TD-03`.

### Client configuration (required for S3-compatible servers)

```typescript
const s3 = new S3Client({
  endpoint: cfg.endpoint,            // http://storage:9000 (service host)
  region: cfg.region,
  forcePathStyle: true,
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
// a SECOND client, identical but with endpoint: cfg.publicEndpoint, is used ONLY to presign
```

Without the two `WHEN_REQUIRED` settings the SDK injects default checksum headers/params (`x-amz-checksum-crc32`, `x-amz-checksum-mode`) that break signatures on S3-compatible servers.

### Multipart upload commands (all in `@aws-sdk/client-s3`)

- `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `{ UploadId }`.
- `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` — PartNumber 1–10000; presigned with `getSignedUrl`, the client `PUT`s the bytes and reads the `ETag` response header.
- `ListPartsCommand({ Bucket, Key, UploadId, PartNumberMarker? })` — paginated; returns `Parts[{ PartNumber, ETag, Size }]` (resume support).
- `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })` — parts sorted ascending.
- `AbortMultipartUploadCommand({ Bucket, Key, UploadId })`.
- `HeadObjectCommand({ Bucket, Key })` → `ContentLength`, `ContentType` (used to verify the real size after complete).
- `PutObjectCommand({ Bucket, Key, Body, ContentType })` for the thumbnail; `DeleteObjectCommand`; `CreateBucketCommand` (treat `BucketAlreadyOwnedByYou` as success).

### Empirical results (probe run against the candidate servers)

Presigned `UploadPart` (3 parts of 5MiB/5MiB/1MiB) → `PUT` → `ListParts` → `CompleteMultipartUpload` → `HeadObject` (size matched) → presigned `GetObject` with `Range: bytes=0-99` returned **206** with `Content-Range`, and `ResponseContentDisposition` produced `Content-Disposition: attachment` — on both `bitnamilegacy/minio` and `rustfs/rustfs`.

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (Context7). Maps to `phase-03-videos/TD-02`, `TD-03` and `TD-06`.

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const partUrl = await getSignedUrl(
  presignClient,                                            // client built with the PUBLIC endpoint
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: cfg.uploadUrlExpirationSeconds },            // default is 900s when omitted
);

const playbackUrl = await getSignedUrl(
  presignClient,
  new GetObjectCommand({ Bucket, Key }),
  { expiresIn: cfg.playbackUrlExpirationSeconds },
);

const downloadUrl = await getSignedUrl(
  presignClient,
  new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="video.mp4"' }),
  { expiresIn: cfg.playbackUrlExpirationSeconds },
);
```

- The signature embeds the host: sign with the endpoint the client will actually call (`S3_PUBLIC_ENDPOINT`); for the worker/API inside Docker use the internal client.
- `GetObjectRequest` accepts `ResponseContentDisposition`, `ResponseContentType`, etc.; they are signed query parameters.
- `unhoistableHeaders` exists for forcing `x-amz-*` headers into the signature; not needed for this phase.
