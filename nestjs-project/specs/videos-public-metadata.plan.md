---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.14
target_file: test/videos-public-metadata.e2e-spec.ts
---

# GET /videos/:publicId Test Plan

## Application Overview

`GET /videos/:publicId` is the public read of a `ready` video: extracted metadata plus a short-lived thumbnail URL. Any other status is indistinguishable from an unknown video.

## Test Scenarios

### 1. Public metadata — ready video

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services. A `ready` video is produced once per file (`beforeAll`) through the real pipeline: `POST /videos`, `PUT` of each part to its presigned URL, `POST /videos/:publicId/upload/complete`, with the processing module running in-process, polling `GET /videos/:publicId/upload` until `ready`.

#### 1.1. ready-video-visible-without-token

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. GET /videos/:publicId without an Authorization header
    - expect: status is 200
    - expect: body has `public_id`, `title`, `duration_seconds`, `width`, `height`, `video_codec`, `bitrate`, `fps`, `thumbnail_url`, `created_at` and `processed_at`

#### 1.2. thumbnail-url-serves-a-jpeg

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. GET the `thumbnail_url` returned by the previous call
    - expect: status is 200 and `Content-Type` is `image/jpeg`

#### 1.3. no-throttling-on-public-metadata

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. Send ten consecutive GET /videos/:publicId requests from the same client
    - expect: all ten answer 200

### 2. Public metadata — not visible

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services. A `ready` video is produced once per file (`beforeAll`) through the real pipeline: `POST /videos`, `PUT` of each part to its presigned URL, `POST /videos/:publicId/upload/complete`, with the processing module running in-process, polling `GET /videos/:publicId/upload` until `ready`.

#### 2.1. draft-processing-failed-unknown-and-malformed-are-not-found

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. GET the route for a `draft`, a `processing` and a `failed` video, for an unknown well-formed id and for `abc`
    - expect: every call answers 404 with `error` = `VIDEO_NOT_FOUND`
