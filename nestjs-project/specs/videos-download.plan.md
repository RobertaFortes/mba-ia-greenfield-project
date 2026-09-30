---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.16
target_file: test/videos-download.e2e-spec.ts
---

# GET /videos/:publicId/download Test Plan

## Application Overview

`GET /videos/:publicId/download` requires authentication and redirects (302) to a presigned URL that makes the browser save the original file under its original filename.

## Test Scenarios

### 1. Download — authenticated

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services. A `ready` video is produced once per file (`beforeAll`) through the real pipeline: `POST /videos`, `PUT` of each part to its presigned URL, `POST /videos/:publicId/upload/complete`, with the processing module running in-process, polling `GET /videos/:publicId/upload` until `ready`.

#### 1.1. download-requires-a-token

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. GET /videos/:publicId/download without an Authorization header
    - expect: status is 401

#### 1.2. download-redirects-with-attachment-disposition

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. GET /videos/:publicId/download with any logged-in user's token, without following redirects
    - expect: status is 302 and a `Location` header is present
  2. GET the `Location` URL with header `Range: bytes=0-9`
    - expect: `Content-Disposition` starts with `attachment; filename="` and contains the original filename

#### 1.3. unsafe-filenames-are-sanitized

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. Upload a video whose `filename` contains quotes and path separators, wait until `ready`, then request the download and read the target's `Content-Disposition`
    - expect: the filename in the header contains no quotes or path separators

### 2. Download — not visible

**Setup:** `beforeEach`: `cleanAllTables`, clear the `@nestjs/throttler` storage, bootstrap `AppModule` with the global `ValidationPipe` and the two exception filters; register, confirm and log in a user through the real auth endpoints to obtain a bearer token. The suite sets `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` and `S3_PUBLIC_ENDPOINT=http://storage:9000` so a ~11MiB generated MP4 uses three parts and presigned URLs are reachable from inside the container. Storage, Redis and Postgres are the real Compose services. A `ready` video is produced once per file (`beforeAll`) through the real pipeline: `POST /videos`, `PUT` of each part to its presigned URL, `POST /videos/:publicId/upload/complete`, with the processing module running in-process, polling `GET /videos/:publicId/upload` until `ready`.

#### 2.1. non-ready-unknown-and-malformed-are-not-found

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-30T15:34:04Z

**Steps:**
  1. GET the download route with a valid token for a `draft`, `processing` and `failed` video, an unknown well-formed id and `abc`
    - expect: every call answers 404 with `error` = `VIDEO_NOT_FOUND`
