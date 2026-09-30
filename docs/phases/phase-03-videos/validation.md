---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-30T17:28:51+0200"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-30T17:28:51+0200"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-30T17:23:56+0200"
issues:
  - id: IC-1
    status: resolved
    summary: "TD-06 lets owner stream a processing video but the endpoint is public"
    resolved_by: phase-03-videos/TD-06
  - id: IC-2
    status: resolved
    summary: "TD-07 lists failed→processing reprocess with no endpoint or capability"
    resolved_by: phase-03-videos/TD-07
  - id: AMB-1
    status: resolved
    summary: "TD-03 requires a title at init, capability says draft is automatic"
    resolved_by: phase-03-videos/TD-03
  - id: MD-1
    status: resolved
    summary: "Env var contract for storage, queue and video limits is not decided"
    resolved_by: phase-03-videos/TD-08
  - id: DG-1
    status: resolved
    summary: "No way to resolve the caller's channel: ChannelsService only creates"
    resolved_by: phase-03-videos/TD-03
  - id: ICC-1
    status: resolved
    summary: "TD-02 S3_PUBLIC_ENDPOINT uses localhost vs the Docker Networking rule"
    resolved_by: phase-03-videos/TD-02
  - id: ICC-2
    status: resolved
    summary: "Global ThrottlerGuard (10 req/60s) would apply to all video endpoints"
    resolved_by: phase-03-videos/TD-06
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

_(preserved from prior revisions — audit trail)_

- **IC-1** _(resolved_by phase-03-videos/TD-06)_ — TD-06 lets owner stream a processing video but the endpoint is public. Revision appended to TD-06: only `ready` videos are streamable; any other status returns 404 to everyone.
- **IC-2** _(resolved_by phase-03-videos/TD-07)_ — TD-07 lists failed→processing reprocess with no endpoint or capability. Revision appended to TD-07: `failed` is terminal in this phase; reprocess is out of scope.
- **AMB-1** _(resolved_by phase-03-videos/TD-03)_ — TD-03 requires a title at init while the draft is automatic. Revision appended to TD-03: required `filename`, `contentType`, `sizeBytes`; optional `title` defaulting to the filename without extension.
- **MD-1** _(resolved_by phase-03-videos/TD-08)_ — Env var contract for storage, queue and video limits is not decided. New TD-08 fixes canonical keys, required credentials and defaults; `/plan-context` regenerated the context and `/plan-validate` re-confirmed.
- **DG-1** _(resolved_by phase-03-videos/TD-03)_ — No way to resolve the caller's channel. Revision appended to TD-03: `ChannelsService.findByUserId` is added in this phase; videos store `channel_id`.
- **ICC-1** _(resolved_by phase-03-videos/TD-02)_ — `S3_PUBLIC_ENDPOINT` uses localhost vs the Docker Networking rule. Revision appended to TD-02 recording it as the single explicit exception (client-facing URL only).
- **ICC-2** _(resolved_by phase-03-videos/TD-06)_ — Global ThrottlerGuard would apply to all video endpoints. Revision appended to TD-06: `stream`/`download` use `@SkipThrottle()`; upload-management endpoints use an explicit `@Throttle` of 60 req/min.
