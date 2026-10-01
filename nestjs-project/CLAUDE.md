# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **Object storage (RustFS):** `docker compose ps storage` — expect `running (healthy)`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `storage` — RustFS (`rustfs/rustfs:1.0.0`, S3-compatible; MinIO community images are no longer published), port `9000`, credentials from `S3_ACCESS_KEY`/`S3_SECRET_KEY`, volume `storage-data`
- `redis` — Redis 7 with append-only persistence (`--appendonly yes`) for the BullMQ queue, volume `redis-data`
- `video-worker` — same image and code as `nestjs-api`, runs `npm run start:worker:dev`: consumes the `video-processing` queue (FFmpeg/ffprobe are installed in `Dockerfile.dev`)
- `mailpit` — SMTP sink for local email, ports `1025` / `8025`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker                     # Run the compiled video-processing worker (node dist/worker/worker.main)
npm run start:worker:dev                 # Worker in watch mode (what the video-worker service runs)
npm run openapi:export                   # Regenerate openapi.json

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

Storage, queue and worker notes for the videos suites:

- The tests use the real Compose services (Postgres, Redis, RustFS) and real FFmpeg. Presigned URLs are fetched from inside the `nestjs-api` container, where `localhost:9000` is not the storage service, so suites use `S3_PUBLIC_ENDPOINT=http://storage:9000`: integration specs set the env var, e2e suites override the `storageConfig`/`videoConfig` providers through `bootstrapVideosApp` (`test/helpers/videos-e2e.helper.ts`), which also sets a 5 MiB part size.
- `src/videos/processing/video.processor.integration-spec.ts` must be the only consumer of the `video-processing` queue: run `docker compose stop video-worker` before it, and `docker compose up -d video-worker` afterwards.
- Specs that read the queue (`test/videos-complete-upload.e2e-spec.ts`, `test/videos-abort-upload.e2e-spec.ts`, `videos.service.integration-spec.ts`) call `queue.pause()` so a running `video-worker` cannot consume the job first.
- `video-worker` and `start:dev` both build into `dist/` (`deleteOutDir`); do not run two watchers at the same time when you rely on `dist/`. For a one-off build check use `npx tsc -p tsconfig.build.json --outDir .tmp-dist` and delete the folder.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Required keys without defaults: `DB_*`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` (the app and the worker fail at boot without them). `.env.example` lists every key, including `S3_*`, `REDIS_*` and `VIDEO_*`.

`S3_PUBLIC_ENDPOINT` (default `http://localhost:9000`) is the host baked into presigned URLs handed to clients; it is the only setting that points at `localhost` on purpose (see the root `CLAUDE.md`, Docker Networking). Service-to-service traffic uses `S3_ENDPOINT` (`http://storage:9000`).

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- `src/storage/` — `StorageModule`/`StorageService`: S3 multipart, object operations and presigned URLs (two S3 clients: service endpoint and client-facing endpoint)
- `src/videos/` — `VideosModule`: upload (`POST /videos`, `GET`/`DELETE /videos/:publicId/upload`, `POST /videos/:publicId/upload/complete`), public `GET /videos/:publicId`, `GET /videos/:publicId/stream` (302 to a presigned URL), authenticated `GET /videos/:publicId/download`; queue producer `VideoQueueService`
- `src/videos/processing/` — `VideoProcessingModule`: `FfmpegService` (ffprobe/ffmpeg over `spawn`, reading the presigned URL), `VideoProcessingService`, `VideoProcessor` (BullMQ consumer)
- `src/worker/` — `WorkerModule` + `worker.main.ts`: standalone application context that runs only the consumer (the API never consumes jobs)
- Video lifecycle: `draft → processing → ready | failed`; `failed` is terminal. Public routes only see `ready` videos; every other state answers `404 VIDEO_NOT_FOUND`

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
