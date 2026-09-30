---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-abort-upload.e2e-spec.ts
---

# DELETE /videos/:publicId/upload Test Plan

## Application Overview

`DELETE /videos/:publicId/upload` cancels an in-progress upload: the multipart upload is aborted in storage and the draft row is removed.

## Test Scenarios

### 1. Abort upload

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services.

#### 1.1. abort-draft-removes-row-and-multipart-upload

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. POST /videos and PUT one part
    - expect: both succeed
  2. DELETE /videos/:publicId/upload with the owner's token
    - expect: status is 204 and the body is empty
  3. Check the database and storage
    - expect: the `videos` row no longer exists
    - expect: listing the parts of the old `upload_id` fails because the upload is gone

#### 1.2. repeated-abort-not-found

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. DELETE the same route a second time
    - expect: status is 404 and `error` = `VIDEO_NOT_FOUND`

#### 1.3. non-draft-video-rejected-and-untouched

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. Complete a full upload so the video is `processing`, then DELETE /videos/:publicId/upload
    - expect: status is 409 and `error` = `VIDEO_INVALID_STATE`
    - expect: the video row still exists with its status unchanged

### 2. Abort upload — access control

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services.

#### 2.1. other-channel-not-found

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. A second user DELETEs the first user's draft
    - expect: status is 404 and `error` = `VIDEO_NOT_FOUND`
    - expect: the draft still exists

#### 2.2. missing-bearer-token-rejected

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. DELETE /videos/:publicId/upload without an Authorization header
    - expect: status is 401
