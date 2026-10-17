WORKING DIRECTORY: D:\Personal Projects\Huseyin\Operations_App

PHASE 4 of 8 — Mobile worker app

## Start of session
Follow AGENTS.md: read AGENTS.md → MEMORY.md → ARCHITECTURE.md → ROADMAP.md → ADR-0002 to ADR-0005 → apps/mobile/memory.md, packages/shared/memory.md, apps/api/memory.md.

Phase 3 is complete. I verified manually in the browser: `pnpm db:reset` ran, and login works for aylin (Administrator), selin (Supervisor) and deniz (Worker). Update MEMORY.md accordingly. Before changing anything, run build, lint, typecheck, test and `pnpm test:integration` to confirm a green start; report and fix anything that fails.

## Goal
A field worker can use HZ on their phone for real work: log in, see and update their tasks, and create work logs with text, photos, location and the custom fields of each log type. This is the first phase a worker can actually use, so prioritise speed and simplicity of input over feature count.

## Worker app — screens and behavior
- **Login / activation** (exists from Phase 3): keep, polish if needed.
- **Home:** today at a glance — tasks assigned to me (due today / overdue first), my recent logs, a big "New log" button.
- **My tasks:** list with filters (open, today, overdue, done), task detail, and status changes the worker is allowed to make (`in_progress`, `blocked` with a reason, `done`). Link to "log work for this task".
- **New work log** — the core screen, must be fast:
  - Choose log type (most-used first). The form is generated from the log type's custom fields (text, number, boolean, select, date), with required-field validation using the shared Zod schemas.
  - Free text, optional task, site and team (pre-filled from the task or the worker's single site/team when obvious).
  - **Photos:** take with the camera or pick from the gallery, several per log, compressed/resized on the phone before upload, with upload progress and retry.
  - **Location:** captured automatically when permission is granted (with accuracy), never blocking the save if denied or unavailable.
  - `occurredAt` defaults to now and can be changed.
  - Generates the `clientId` on the phone so a retried submit never creates duplicates.
- **My logs:** list and detail, edit within the allowed window while not approved (rules from Phase 3), show approval status and a rejection reason if any.
- **Notifications:** an in-app list (new task assigned, log approved/rejected) plus push notifications — see below.
- **Profile / settings:** name, role, sign out, sign out everywhere, app version, small "Powered by Kaneri.ai".
- Supervisors and managers who log in on mobile get the same worker screens for their own work; their management views come in Phase 6 (web). Don't build approval screens on mobile now.

## Design and usability
- HZ design tokens from packages/shared. Large touch targets, readable in sunlight, works one-handed, works with gloves where practical (big buttons, few tiny controls).
- Clear empty, loading and error states. Never lose what the worker typed if a request fails: keep the form contents until it is saved.
- Internationalisation-ready: all user-facing text through an i18n layer, English now, structured so Turkish and Arabic (right-to-left) can be added without code changes to screens.
- Accessibility: screen-reader labels, dynamic text size, contrast checked against the tokens.

## Backend work needed
- **File storage:** implement the storage interface from Phase 2 with an S3-compatible provider. For development, run MinIO in Docker Compose (add it next to PostgreSQL, bound to 127.0.0.1). Uploads go via short-lived pre-signed URLs, or through the API if you judge that safer — justify the choice in ADR-0006.
- **The API generates storage keys** (fixes the Phase 2/3 limitation); clients never choose keys. Validate file type (images only for now: JPEG, PNG, HEIC/HEIF converted or accepted as you decide) and size limit (configurable). Downloads also via short-lived signed URLs, only for users allowed to see the parent work log.
- Thumbnails or resized variants for lists, generated where you judge best.
- **Push notifications:** behind a notification-channel interface (reusable Kaneri platform component; Phase 7 will send AI alerts through it). Use Expo push notifications. Store device push tokens per user/session; remove them on sign-out and when Expo reports them invalid. Trigger from outbox events: task assigned to me, my log approved/rejected. Note: remote push may not work in Expo Go on all platforms in this SDK; check, and if a development build is required, set it up (EAS development build or local build) and document exactly how I install it on my phone. The in-app notification list must work regardless.
- Any new endpoints follow the Phase 3 rules: a declared policy on every route, scope-filtered queries, role-shaped responses, audit and outbox on every write.

## Out of scope
Offline storage and sync (Phase 5) — but structure the data layer so Phase 5 can add a local queue without rewriting screens (e.g. all writes go through one repository/service on the phone). Web dashboard features (Phase 6). AI features (Phase 7). Mobile approval screens.

## Phone testing setup (I will test on a real phone)
- My PC is on campus Wi-Fi that blocks phone-to-PC traffic, so I will connect the PC to my phone's hotspot.
- Document exactly what to change for a phone test: API_HOST to 0.0.0.0 temporarily (and why to switch back), EXPO_PUBLIC_API_URL to the PC's hotspot IP, MinIO's URL being reachable from the phone for signed URLs, and the Windows Firewall prompts to accept.
- Add a short "test on my phone" section to the README covering Expo Go and, if needed, the development build.

## Before building
Per AGENTS.md, first state: business objective, expected behavior, components affected, data required, external integrations, failure cases, test plan. Write ADR-0006 (file storage and upload flow) and ADR-0007 (push notifications and the notification-channel interface). Then proceed without waiting for approval.

## Subagents
- Run in parallel: one subagent for backend storage + uploads + signed downloads, one for push notifications and the notification-channel component, one for the mobile screens and data layer (after the API contracts in packages/shared are agreed).
- Use the project `test-writer` subagent for: dynamic form generation and validation for every custom field type; duplicate submit with the same clientId; upload validation (type, size, server-generated keys, no access to another worker's photos); push token lifecycle; notifications only to the right users; worker task-status rules; edit-window rules from the phone.
- Then run the project `reviewer` subagent against this prompt, AGENTS.md and the Phase 3 security rules; fix what it finds.
- Finally run `docs-keeper` to update MEMORY.md, ARCHITECTURE.md, ROADMAP.md (Phase 4 done-when criteria), ADRs, README and every touched folder's memory.md.

## When finished
- Run install, build, lint, typecheck, test, test:integration and format:check; apply migrations; confirm `pnpm dev` starts everything including MinIO. Do not run `pnpm db:reset` yourself if the permission system blocks it — tell me to run it.
- Give me the end-of-change summary described in AGENTS.md.
- Give me an exact step-by-step phone test: setup (hotspot, env changes, firewall), then as deniz (worker): see tasks, change a task status, create a log with a photo, location and custom fields, see it in My logs, edit it, sign out. Then as selin (supervisor) approve that log via Swagger or the web, and confirm deniz gets the notification. Include how to switch the env back afterwards.
- Do not commit; I will review and commit myself.
