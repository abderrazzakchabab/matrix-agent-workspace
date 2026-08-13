# Matrix Agent Workspace

A staged project for a Matrix mobile client backed by configurable Vercel-hosted AI agents and GitHub team collaboration.

## Delivery order

1. Durable multi-agent backend with Matrix/Synapse integration.
2. Mobile Matrix client.
3. GitHub collaboration workspace with write actions.

The implementation plan is at `docs/superpowers/plans/2026-08-12-matrix-agent-workspace.md`.

## Mobile client

The Expo shell supports Matrix login, explicit room-to-workspace binding, and launching parallel or sequential specialist runs. It stores only the opaque control-plane session reference in the platform secure store; the Matrix access token is used only during login.

From the repository root, start the control plane and Expo in separate terminals:

```sh
# Terminal 1
pnpm --filter @matrix/control-plane dev

# Terminal 2
EXPO_PUBLIC_CONTROL_PLANE_URL=http://localhost:3000 pnpm --filter @matrix/mobile start
```

For a physical device, replace `localhost` with a control-plane URL reachable from that device. Run progress and terminal-state UI are reserved for the next mobile phase.

## Phase B backend gate

The deterministic backend acceptance stack requires Docker and exposes PostgreSQL/pgvector, Synapse, model-provider, GitHub, and Inngest fixtures. Playwright starts the Next.js control plane for the gate.

```sh
pnpm test:fixtures:up      # start fixtures and seed alice/bob plus #alice:example.test
pnpm test:fixtures:health  # verify every fixture is healthy
pnpm test:phase-b          # start fixtures and run the Phase B Playwright/API gate
pnpm test:fixtures:down    # stop and remove fixture containers
```

The seeded Matrix passwords are `alice_secret` and `bob_secret`. The fixture stack is deterministic and test-only; `test:phase-b` leaves it running for inspection, so use `test:fixtures:down` when finished.
