---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-30T17:05:40+0200"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-30T17:17:17+0200"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-09-30T17:06:00+0200"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-09-30T17:06:00+0200"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-30T17:06:00+0200"
  docs/phases/phase-01-configuracao-base/context.md: "2026-09-30T17:06:00+0200"
  docs/phases/phase-02-auth/context.md: "2026-09-30T17:06:00+0200"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-09-30T17:05:40+0200"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`)

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição das informações do vídeo (título, descrição, categoria, thumbnail customizada), visibilidade público/unlisted, fluxo de publicação e painel do canal (Fase 04); player e página de visualização (Fase 05); interações sociais (Fase 06).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (module, entity, migration, worker entry point, `compose.yaml`).

**Deferred subprojects:** `next-frontend/` — the phase has no UI bullet; the video interface is not part of this phase.

**Sequencing notes:** Depends on Fase 01 (Configuração Base) and Fase 02 (Auth). The video belongs to the channel created in Fase 02 (1:1 with the user).

**Neighbors (for boundary detection only):**

- **Fase 02:** Cadastro, Login e Gerenciamento de Conta (prior) — provides users, channels and the global JWT guard.
- **Fase 04:** Gerenciamento de Vídeos e Canal (next) — edits video info, draft→publication flow, visibility.
- **Fase 05:** Página de Visualização do Vídeo (later) — consumes streaming and download.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Message Queue Technology | decided | A (BullMQ + Redis) | — |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Object Storage Runtime, Client and Key Layout | decided | B (RustFS pinned tag + AWS SDK v3) | — |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Cross-layer | Upload Strategy for Files up to 10GB | decided | A (presigned S3 multipart) | — |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Video Processing Worker and FFmpeg Execution | decided | A (same codebase, separate container, `spawn` over presigned URLs) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Cross-layer | Unique Public URL Identifier | decided | A (11-char base64url + unique index) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Cross-layer | Streaming and Download Delivery | decided | A (302 to presigned GET) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle and Failure Handling | decided | A (`draft → processing → ready \| failed`) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04, phase-03-videos/TD-07 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-03, phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-07 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — it gives retry/backoff and a final-failure hook out of the box with an official NestJS module (`@nestjs/bullmq`), matching the "fila real subindo no Compose" requirement with the least custom code; pg-boss would hide the queue inside the database and RabbitMQ would force hand-built retry topology for no routing benefit.

**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** RustFS with a pinned tag for the Compose `storage` service (MinIO's official images are no longer published — pulls fail; the frozen legacy copy is a verified fallback). The code talks only to the S3 API through AWS SDK v3 (`forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'`, `responseChecksumValidation: 'WHEN_REQUIRED'`), with two endpoints (`S3_ENDPOINT` for services, `S3_PUBLIC_ENDPOINT` only to sign client-facing URLs), one private bucket and keys `videos/{videoId}/original.{ext}` and `videos/{videoId}/thumbnail.jpg`.

**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** Presigned S3 multipart upload straight to storage — the only option where the 10GB never touches the API and resume is native (`ListParts`). Contract: limit 10GiB validated at init and re-verified with `HeadObject` on complete; part size `max(VIDEO_UPLOAD_PART_SIZE_BYTES, ceil(size/10000))` (default 128MiB); draft row created at init with the `uploadId`; endpoints init / resume-info / complete / abort; accepted types `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`; only the channel owner can operate.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** Same codebase, separate worker container (Nest standalone context with a BullMQ `@Processor`); `ffprobe`/`ffmpeg` invoked with `child_process.spawn` over presigned internal URLs (HTTP range reads, no local copy of the file); avoids the deprecated `fluent-ffmpeg`. Persist duration/dimensions/codecs/bitrate/format/fps plus a `metadata` JSONB; thumbnail is one JPEG frame at `min(1s, 10% of duration)`, max width 1280px, at `videos/{videoId}/thumbnail.jpg`; job payload `{ videoId, storageKey }` with `jobId = videoId`; idempotent processor; FFmpeg bounded by `VIDEO_PROCESSING_TIMEOUT_SECONDS`.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Random 11-character base64url id (`crypto.randomBytes(8)`) with a `UNIQUE` index and bounded retry on collision — short and unique by construction with no dependency; UUID is too long for the plan's "URL curta" and slugs cannot stay stable when titles are edited in Fase 04.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** API endpoints that authorize and redirect (302) to short-lived presigned GET URLs — the API decides who may fetch, storage serves the bytes with native range/206 support, matching the target architecture (frontend streams from storage). Access rules: `stream` is public and only for `ready` videos (404 otherwise, owner may stream own `processing` video); `download` requires authentication and `ready` status; presigned GET expiry `VIDEO_PLAYBACK_URL_EXPIRATION_SECONDS` (default 300).

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** `draft → processing → ready | failed`, retries in the queue (`attempts: 3`, exponential backoff 5s), failure persisted by the worker on the final attempt with `processingError`. Transitions: `draft → processing` (complete), `processing → ready`, `processing → failed`, `failed → processing` (reprocess), abort deletes a draft. Enqueue happens after the DB commit; if it fails the API sets `failed` (`ENQUEUE_FAILED`) and answers 503. The processor is idempotent (skips if already `ready`).

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability. The `registerAs()` factory is dual-purpose: DI token + plain importable function.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### openapi-docs-nestjs/TD-01

**Recommendation:** **Option A (`@nestjs/swagger`)** — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.

**Libraries:** —

### openapi-docs-nestjs/TD-02

**Recommendation:** **Option C (Ambos)** — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`; new variables also go to `.env.example` and `compose.yaml`. _(from phase 01/02)_
- Config is injected with `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`; schema changes only via migrations in `src/database/migrations/` (`<timestamp>-<Name>.ts`). _(from phase 01/02)_
- Each domain feature is its own module registered in `AppModule`; entities live in `<module>/entities/*.entity.ts` with UUID primary keys and snake_case columns (`created_at`, `updated_at`, `user_id`). _(from phase 02)_
- Domain errors extend `DomainException(errorCode, httpStatus, message)` and are rendered by `DomainExceptionFilter` as `{ statusCode, error, message }`; validation errors go through `ValidationExceptionFilter`. Global `ValidationPipe` uses `whitelist`, `forbidNonWhitelisted`, `transform`. _(from phase 02)_
- Endpoints are protected by the global `JwtAuthGuard`; `@Public()` opts out; `@CurrentUser()` returns `JwtPayload { sub: userId, email }`. The channel of a user is the 1:1 `Channel` (`channels.user_id`). _(from phase 02)_
- Controllers are documented with `@nestjs/swagger` (`@ApiTags`, `@ApiOperation`, `@ApiResponse` with `ApiErrorEnvelope` for errors) and `nestjs-project/openapi.json` is re-exported when the API surface changes. _(from phase 02 / openapi-docs-nestjs)_
- Test suffixes: `*.spec.ts` (unit, no I/O), `*.integration-spec.ts` (real DB/services), `*.e2e-spec.ts` in `test/` (supertest); integration and e2e run `--runInBand`. Every command runs inside the `nestjs-api` container; service hosts are Compose service names, never `localhost`. _(from phase 01/02, `nestjs-project/CLAUDE.md`)_
- Non-TypeScript runtime assets must be declared in `nest-cli.json` `compilerOptions.assets`. _(from phase 02)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`.

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with side-effect dependency (email, storage) | Integration: real capture service or local adapter (here: real storage and real queue from Compose) |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — no unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service) | E2E + Unit if complex internal logic |
| Exception Filter | Unit + E2E |

### next-frontend

_Deferred subproject — no work in this phase._
