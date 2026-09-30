---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-complete-upload.e2e-spec.ts
---

# POST /videos/:publicId/upload/complete Test Plan

## Application Overview

`POST /videos/:publicId/upload/complete` finishes the multipart upload, verifies the stored size, moves the video to `processing` and enqueues the processing job; the queue is real Redis.

## Test Scenarios

### 1. Complete upload — success

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services. Only scenario 2.3 replaces `VideoQueueService` with a stub that throws, because a real Redis outage cannot be simulated inside the suite.

#### 1.1. complete-moves-to-processing-and-enqueues-job

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. POST /videos, PUT the three parts and collect their ETags
    - expect: all PUTs answer 200
  2. POST /videos/:publicId/upload/complete with `{ parts: [{ part_number, etag }, ...] }`
    - expect: status is 202
    - expect: body has `id`, `public_id` and `status` = `processing`
  3. Read the `video-processing` queue
    - expect: a job exists whose id equals the video id and whose data is `{ videoId, storageKey }`

#### 1.2. second-complete-rejected-with-conflict

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. POST the same complete request again
    - expect: status is 409 and `error` = `VIDEO_INVALID_STATE`

### 2. Complete upload — incomplete or inconsistent uploads

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services. Only scenario 2.3 replaces `VideoQueueService` with a stub that throws, because a real Redis outage cannot be simulated inside the suite.

#### 2.1. missing-parts-rejected-and-video-stays-draft

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. PUT only two of three parts and POST complete with those two
    - expect: status is 400 and `error` = `VIDEO_UPLOAD_INCOMPLETE`
  2. GET /videos/:publicId/upload
    - expect: `status` = `draft`

#### 2.2. size-mismatch-fails-video-and-removes-object

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. POST /videos declaring `size_bytes: 12000000` (3 parts) but PUT parts totalling 11534336 bytes, then POST complete
    - expect: status is 400 and `error` = `VIDEO_SIZE_MISMATCH`
  2. Inspect the video and the storage object
    - expect: the video `status` = `failed` and the object is no longer in storage

#### 2.3. queue-unavailable-fails-video-with-503

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. With `VideoQueueService.enqueue` stubbed to throw, upload all parts and POST complete
    - expect: status is 503 and `error` = `VIDEO_QUEUE_UNAVAILABLE`
  2. Read the video row
    - expect: `status` = `failed` and `processing_error` = `ENQUEUE_FAILED`

### 3. Complete upload — access control and validation

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services. Only scenario 2.3 replaces `VideoQueueService` with a stub that throws, because a real Redis outage cannot be simulated inside the suite.

#### 3.1. other-channel-not-found

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. A second user POSTs complete for the first user's draft
    - expect: status is 404 and `error` = `VIDEO_NOT_FOUND`

#### 3.2. empty-parts-array-rejected

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. POST complete with `{ parts: [] }`
    - expect: status is 400 and `error` = `VALIDATION_ERROR`
