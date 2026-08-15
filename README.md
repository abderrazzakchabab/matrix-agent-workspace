# Matrix Agent Workspace

A staged project for a Matrix mobile client backed by configurable Vercel-hosted AI agents and GitHub team collaboration.

## Delivery order

1. Durable multi-agent backend with Matrix/Synapse integration.
2. Mobile Matrix client.
3. GitHub collaboration workspace with write actions.

The implementation plan is at `docs/superpowers/plans/2026-08-12-matrix-agent-workspace.md`.

## Mobile client

The Expo client supports Matrix login, workspace creation, explicit room-to-workspace binding, and launching and monitoring parallel or sequential specialist runs. The run screen replays durable progress, supports cancellation through the terminal event, renders completed, partial, failed, and cancelled results, and confirms delivery to Matrix without duplicating the result. The client stores only the opaque control-plane session reference in the platform secure store; the Matrix access token is used only during login.

From the run screen, the GitHub workspace header action opens the collaboration workspace: read-only repository, issue, and pull-request panels, a mutation control that appears only while a write grant for the exact repository and scope is pending or approved, an explicit confirmation showing the scope, repository, and normalized arguments before any write (approval is never inferred from opening the screen), idempotent mutation submission with visible command status, and a redacted audit history. Set `EXPO_PUBLIC_GITHUB_INSTALLATION_ID` to the GitHub App installation the workspace should read through.

From the repository root, start the control plane and Expo in separate terminals:

```sh
# Terminal 1
pnpm --filter @matrix/control-plane dev

# Terminal 2
EXPO_PUBLIC_CONTROL_PLANE_URL=http://localhost:3000 pnpm --filter @matrix/mobile start
```

For a physical device, replace `localhost` with a control-plane URL reachable from that device.

## Phase gates

The deterministic acceptance stack requires Docker and exposes PostgreSQL/pgvector, Synapse, model-provider, GitHub, and Inngest fixtures. Playwright starts the Next.js control plane for the Phase B gate, and the control plane plus the Expo web build for the Phase A mobile gate.

```sh
pnpm test:fixtures:up      # start fixtures and seed alice/bob plus #alice:example.test
pnpm test:fixtures:health  # verify every fixture is healthy
pnpm test:phase-b          # start fixtures and run the Phase B Playwright/API gate
pnpm exec playwright test apps/mobile/test/e2e/phase-a-mobile.spec.ts   # Phase A mobile gate (fixtures must be up)
pnpm test:fixtures:down    # stop and remove fixture containers
```

The seeded Matrix passwords are `alice_secret` and `bob_secret`. The fixture stack is deterministic and test-only; the gates leave it running for inspection, so use `test:fixtures:down` when finished.
