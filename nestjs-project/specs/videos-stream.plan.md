---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.15
target_file: test/videos-stream.e2e-spec.ts
---

# GET /videos/:publicId/stream Test Plan

## Application Overview

`GET /videos/:publicId/stream` authorizes and redirects (302) to a short-lived presigned URL; storage serves the bytes and answers `Range` requests with 206, so playback never requires the whole file.

## Test Scenarios

### 1. Streaming — ready video

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services. A `ready` video is produced once per file (`beforeAll`) through the real pipeline: `POST /videos`, `PUT` of each part to its presigned URL, `POST /videos/:publicId/upload/complete`, with the processing module running in-process, polling `GET /videos/:publicId/upload` until `ready`.

#### 1.1. stream-redirects-to-presigned-url

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. GET /videos/:publicId/stream without an Authorization header, without following redirects
    - expect: status is 302 and a `Location` header is present

#### 1.2. range-request-on-target-returns-partial-content

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. GET the `Location` URL with header `Range: bytes=0-99`
    - expect: status is 206
    - expect: `Content-Range` starts with `bytes 0-99/`
    - expect: exactly 100 bytes are returned

#### 1.3. no-throttling-on-stream

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. Send fifteen consecutive GET /videos/:publicId/stream requests from the same client
    - expect: all fifteen answer 302

### 2. Streaming — not visible

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services. A `ready` video is produced once per file (`beforeAll`) through the real pipeline: `POST /videos`, `PUT` of each part to its presigned URL, `POST /videos/:publicId/upload/complete`, with the processing module running in-process, polling `GET /videos/:publicId/upload` until `ready`.

#### 2.1. non-ready-unknown-and-malformed-are-not-found

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. GET the stream route for a `draft`, `processing` and `failed` video, an unknown well-formed id and `abc`
    - expect: every call answers 404 with `error` = `VIDEO_NOT_FOUND`
