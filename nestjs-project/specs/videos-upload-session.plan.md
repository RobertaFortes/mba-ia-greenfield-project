---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-upload-session.e2e-spec.ts
---

# GET /videos/:publicId/upload Test Plan

## Application Overview

`GET /videos/:publicId/upload` lets the owner resume an interrupted upload: it lists the parts already stored and returns presigned URLs for the missing parts; for non-draft videos it reports the status.

## Test Scenarios

### 1. Resume upload — draft

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services.

#### 1.1. partial-upload-lists-uploaded-and-pending-parts

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. POST /videos for a ~11MiB file (3 parts) and PUT parts 1 and 2 to their URLs
    - expect: both PUTs answer 200
  2. GET /videos/:publicId/upload with the owner's token
    - expect: status is 200
    - expect: `uploaded_parts` has 2 items with `part_number`, `size_bytes` and `etag`
    - expect: `pending_parts` has 1 item `{ part_number: 3, url }`
  3. PUT the last bytes to the returned pending URL
    - expect: status is 200 with an `ETag`

### 2. Resume upload — other states

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services.

#### 2.1. non-draft-reports-status-with-empty-arrays

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. Complete a full upload and let it reach `processing` or `ready`, then GET /videos/:publicId/upload
    - expect: status is 200 and `status` is not `draft`
    - expect: `uploaded_parts` and `pending_parts` are empty and `upload_id` is null
  2. Force a video to `failed` with `processing_error` set and GET the same route
    - expect: `status` = `failed` and `processing_error` is a non-empty string

### 3. Resume upload — access control

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services.

#### 3.1. other-channel-and-unknown-id-look-identical

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. A second user calls GET /videos/:publicId/upload for the first user's video
    - expect: status is 404 and `error` = `VIDEO_NOT_FOUND`
  2. The first user calls the route with a well-formed but unknown id
    - expect: status is 404 with the same body shape

#### 3.2. malformed-public-id-not-found

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. GET /videos/abc/upload with a valid token
    - expect: status is 404 and `error` = `VIDEO_NOT_FOUND`

#### 3.3. missing-bearer-token-rejected

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. GET /videos/:publicId/upload without an Authorization header
    - expect: status is 401
