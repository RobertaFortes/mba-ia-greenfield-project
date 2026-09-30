---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-init-upload.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

`POST /videos` pre-registers a draft video in the caller's channel, opens the S3 multipart upload and returns one presigned URL per part so the client uploads straight to storage.

## Test Scenarios

### 1. Start upload — success

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services.

#### 1.1. valid-body-returns-draft-with-part-urls

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. POST /videos with a bearer token and body `{ filename: 'clip.mp4', content_type: 'video/mp4', size_bytes: 11534336 }`
    - expect: status is 201
    - expect: body has `id`, `public_id`, `status` = `draft`, `title`, `upload_id`, `part_size_bytes`, `total_parts` = 3, `url_expires_in_seconds` and `parts` with 3 items `{ part_number, url }`
    - expect: `public_id` has 11 characters

#### 1.2. title-defaults-to-filename-without-extension

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. POST /videos with `filename: 'my holiday.mov'`, `content_type: 'video/quicktime'` and no `title`
    - expect: status is 201
    - expect: `title` equals `my holiday`

#### 1.3. draft-row-owned-by-callers-channel-and-part-url-accepts-bytes

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. POST /videos with a valid body
    - expect: status is 201
  2. Read the `videos` row by `public_id`
    - expect: `status` = `draft` and `channel_id` equals the caller's channel id
  3. PUT 5MiB of bytes to `parts[0].url`
    - expect: status is 200 and the response has an `ETag` header

#### 1.4. public-ids-are-unique-across-calls

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. POST /videos twice with the same body
    - expect: both answer 201
    - expect: the two `public_id` values differ

### 2. Start upload — size and type limits

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services.

#### 2.1. ten-gib-accepted-with-eighty-parts

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. POST /videos with `size_bytes: 10737418240` and the default part size configured (128MiB)
    - expect: status is 201 and `total_parts` = 80

#### 2.2. above-ten-gib-rejected

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. POST /videos with `size_bytes: 10737418241`
    - expect: status is 400 and `error` = `VIDEO_FILE_TOO_LARGE`

#### 2.3. unsupported-content-type-rejected

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. POST /videos with `content_type: 'video/avi'`
    - expect: status is 400 and `error` = `VIDEO_UNSUPPORTED_CONTENT_TYPE`

### 3. Start upload — validation and authentication

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services.

#### 3.1. unknown-properties-and-invalid-size-rejected

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. POST /videos with an extra property `foo`
    - expect: status is 400 and `error` = `VALIDATION_ERROR`
  2. POST /videos with `size_bytes: 0` and with `size_bytes: 'abc'`
    - expect: both answer 400 with `error` = `VALIDATION_ERROR`

#### 3.2. missing-bearer-token-rejected

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. POST /videos without an Authorization header
    - expect: status is 401
