# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Backend sharp edges

- **RLS tenant context:** the app connects as `matrix_app` (subject to RLS); migrations/fixtures connect as the table-owner `matrix`. Policies key on the `app.user_id`/`app.workspace_ids` GUCs. Custom GUCs revert to an empty string after a `SET LOCAL` commit, so policies must read them via the `app_user_id()`/`app_workspace_ids()` NULLIF helpers defined in `apps/control-plane/src/db/migrations/0001_identity_and_bindings.sql`.
- **Synapse fixture** (`infra/docker-compose.test.yml`): the image drops to uid 991 via gosu, so writable state lives under `infra/synapse/runtime/` (git-ignored) and is chowned by the entrypoint; the signing key is generated at startup, never committed. Login/join/message rate limits are relaxed in `infra/synapse/homeserver.yaml` so the four auth test files can seed users/rooms without 429s.
- **Integration tests** need `docker-compose -f infra/docker-compose.test.yml up -d postgres synapse` plus `exec -T synapse /tests/fixtures/synapse/seed.sh` (creates alice/bob, passwords `alice_secret`/`bob_secret`). The auth test files reset shared tables; `vitest.config.ts` sets `fileParallelism: false` to avoid cross-file interference.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
