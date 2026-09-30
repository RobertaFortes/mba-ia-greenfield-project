---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 7
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-30T17:19:10+0200"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-30T17:17:17+0200"
issues:
  - id: IC-1
    status: open
    summary: "TD-06 lets owner stream a processing video but the endpoint is public"
  - id: IC-2
    status: open
    summary: "TD-07 lists failed→processing reprocess with no endpoint or capability"
  - id: AMB-1
    status: open
    summary: "TD-03 requires a title at init, capability says draft is automatic"
  - id: MD-1
    status: open
    summary: "Env var contract for storage, queue and video limits is not decided"
  - id: DG-1
    status: open
    summary: "No way to resolve the caller's channel: ChannelsService only creates"
  - id: ICC-1
    status: open
    summary: "TD-02 S3_PUBLIC_ENDPOINT uses localhost vs the Docker Networking rule"
  - id: ICC-2
    status: open
    summary: "Global ThrottlerGuard (10 req/60s) would apply to all video endpoints"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `phase-03-videos/TD-06` says `stream` "is public" and, at the same time, that "owner may stream own `processing` video". A `@Public()` route skips `JwtAuthGuard`, so the request carries no identity (`request.user` is never populated, see Inherited Conventions) and the owner exception cannot be evaluated; no TD defines optional authentication. Explicit choice: (a) remove the owner exception — only `ready` videos are streamable, everyone else gets `404` (no capability of the phase asks for previewing an unprocessed video); or (b) add a TD for optional bearer authentication on public routes.
- **IC-2** — `phase-03-videos/TD-07` lists the transition `failed → processing` ("explicit reprocess"), but `phase-03-videos/TD-03` defines only init / resume-info / complete / abort as endpoints and no capability bullet of the phase asks for reprocessing. The transition has no entry point. Explicit choice: (a) drop the reprocess transition (a failed video is terminal in this phase; the user uploads again); or (b) add a reprocess endpoint to TD-03 and justify it against a capability.

### Ambiguities

- **AMB-1** — `phase-03-videos/TD-03` says the draft is created by the init request with "title required", while the capability is "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" and title editing belongs to Fase 04. It is unclear which fields the client sends at init and where the initial title comes from. Explicit choice: define the init payload (e.g. required `filename`, `contentType`, `sizeBytes`; optional `title` defaulting to the filename without extension).

### Missing Decisions

- **MD-1** — The phase adds infrastructure (storage, queue, worker) and limits that must stay consistent across the Joi schema, `.env.example`, `compose.yaml` and code. TDs cite only some variables (`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_BUCKET`, `VIDEO_UPLOAD_PART_SIZE_BYTES`, `VIDEO_UPLOAD_URL_EXPIRATION_SECONDS`, `VIDEO_PLAYBACK_URL_EXPIRATION_SECONDS`, `VIDEO_PROCESSING_TIMEOUT_SECONDS`); credentials, region and the Redis connection are not named, and none has a defined default/required status. A canonical set of keys is a cross-component contract. Explicit choice: run /research (or add a TD) that fixes the canonical env keys, required-vs-default, and which values are safe defaults.

### Dependency Gaps

- **DG-1** — Every video endpoint needs the caller's channel (`JwtPayload.sub` is the user id; the video belongs to a channel). Fase 02 delivered the 1:1 `Channel` entity but `ChannelsService` exposes only `createChannel`. Explicit choice: add a lookup by user id (e.g. `ChannelsService.findByUserId`) as part of this phase, keeping `ChannelsModule` as its owner.

### Inherited Constraint Conflicts

- **ICC-1** — `phase-03-videos/TD-02` introduces `S3_PUBLIC_ENDPOINT` with a `localhost` host (client-facing URL), while the inherited convention says all service hosts are Compose service names and never `localhost`. The TD explains the exception, but the exception is not recorded against the inherited rule. Explicit choice: keep the decision and record the exception explicitly (the value is never used for a service-to-service connection; `S3_ENDPOINT=http://storage:9000` remains the service host), and update the project docs that state the rule.
- **ICC-2** — Inherited `phase-02-auth/TD-08` (`@nestjs/throttler`) is registered through `APP_GUARD` in `AuthModule`, which applies to every route (limit 10 requests per 60 s per IP; only `AppController` uses `@SkipThrottle()`), although the TD text speaks of scoping it to auth. Video endpoints (init, resume-info, complete, `stream`, `download`) and their e2e suites would inherit a 10 req/min ceiling. Explicit choice: define the throttle policy for the videos module (e.g. explicit `@Throttle` limits per route, `stream`/`download` exempt), stated as a usage note on the inherited TD.

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

_No issues resolved yet._
