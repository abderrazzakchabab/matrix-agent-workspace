# Graph Report - 01KZYKB711E8CC5DRCBJSPZSQ1  (2026-08-14)

## Corpus Check
- 133 files · ~66,958 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1165 nodes · 2219 edges · 78 communities (62 shown, 16 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 7 edges (avg confidence: 0.59)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `e16642e8`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- dependencies
- read-client.ts
- agent-config.ts
- run-workflow.ts
- auth/support.ts
- provider.ts
- authorization.ts
- phase-b-backend.spec.ts
- Phase B — Backend first
- WorkflowServices
- event-service.ts
- RootNavigator.tsx
- RunComposerScreen.tsx
- app-auth.ts
- RunScreen.tsx
- scripts
- index.ts
- delivery-worker.ts
- delivery-deduplication.test.ts
- workflows/support.ts
- withTenant
- executeRun
- db/client.ts
- prompt-envelope.ts
- matrix-token.ts
- read-only.test.ts
- oauth.ts
- expo
- TerminalResult.tsx
- contracts/package.json
- message-renderer.ts
- control-plane.ts
- run-events.ts
- dependencies
- deliver-matrix-event.ts
- session-service.ts
- envelope-encryption.ts
- compilerOptions
- devDependencies
- sse-replay.test.ts
- include
- session-store.ts
- github/server.ts
- model/server.ts
- include
- cancel/route.ts
- memory-repository.ts
- oauth-state.test.ts
- issues/route.ts
- SynapseClient
- FrameReader
- repositories/route.ts
- WorkflowRunStore
- scripts
- RoomBindingScreen.tsx
- InMemoryOAuthStateStore
- schema/github.ts
- rooms.ts
- workspaces.ts
- mobile/package.json
- playwright.config.ts
- Matrix Agent Workspace
- Project agent memory
- Test fixtures
- health/route.ts
- agents.ts
- checkpoints.ts
- users.ts
- GithubOAuthService
- OAuthStateService
- next.config.ts
- expo
- @matrix/contracts
- react-native
- react-native-safe-area-context
- github/README.md
- seed.sh

## God Nodes (most connected - your core abstractions)
1. `withTenant()` - 49 edges
2. `toErrorResponse()` - 30 edges
3. `requireSession()` - 29 edges
4. `executeRun()` - 24 edges
5. `getAdminPool()` - 22 edges
6. `getPool()` - 17 edges
7. `POST()` - 15 edges
8. `UntrustedSpan` - 14 edges
9. `ControlPlaneApi` - 14 edges
10. `compilerOptions` - 14 edges

## Surprising Connections (you probably didn't know these)
- `makeRun()` --calls--> `createRun()`  [EXTRACTED]
  apps/control-plane/test/events/sse-replay.test.ts → apps/control-plane/src/db/repositories/run-repository.ts
- `SpecialistProviderRequest` --references--> `SpecialistProfile`  [EXTRACTED]
  apps/control-plane/src/agents/provider.ts → apps/control-plane/src/agents/agent-config.ts
- `RunRequestedEventData` --references--> `UntrustedSpan`  [EXTRACTED]
  apps/control-plane/src/inngest/client.ts → apps/control-plane/src/agents/prompt-envelope.ts
- `executeRun()` --calls--> `applyPromptInjectionPolicy()`  [EXTRACTED]
  apps/control-plane/src/workflows/run-workflow.ts → apps/control-plane/src/agents/prompt-envelope.ts
- `DeterministicProvider` --implements--> `SpecialistProvider`  [EXTRACTED]
  apps/control-plane/test/workflows/support.ts → apps/control-plane/src/agents/provider.ts

## Import Cycles
- None detected.

## Communities (78 total, 16 thin omitted)

### Community 0 - "dependencies"
Cohesion: 0.04
Nodes (46): ai, @ai-sdk/anthropic, @ai-sdk/openai-compatible, @ai-sdk/provider, dependencies, ai, @ai-sdk/anthropic, @ai-sdk/openai-compatible (+38 more)

### Community 1 - "read-client.ts"
Cohesion: 0.10
Nodes (26): JsonObject, login(), NormalizedIssue, NormalizedPullRequest, NormalizedPullRequestFile, NormalizedPullRequestReview, NormalizedRepository, normalizeIssue() (+18 more)

### Community 2 - "agent-config.ts"
Cohesion: 0.07
Nodes (29): defineSpecialist(), GITHUB_MUTATION_TOOLS, InvalidSpecialistConfigurationError, isReadOnlyTool(), PriorSpecialistResult, READ_ONLY_TOOL_ALLOWLIST, SpecialistDefinition, SpecialistOutputInvalidError (+21 more)

### Community 3 - "run-workflow.ts"
Cohesion: 0.09
Nodes (29): resolveExecutionOrder(), validateSpecialistProfiles(), CreateRunBody, POST(), RoomNotBoundError, createPostgresCancellationController(), createPostgresCheckpointStore(), computeExecutionKey() (+21 more)

### Community 4 - "auth/support.ts"
Cohesion: 0.14
Nodes (26): ApiErrorBody, cancelRun(), dispatchMock, getRun(), jsonRequest(), matrixDispatchMock, postRun(), RunBody (+18 more)

### Community 5 - "provider.ts"
Cohesion: 0.08
Nodes (16): ReadOnlyToolName, createVercelAiGatewayProvider(), GatewayAdapter, getAiGatewayApiKey(), getAiGatewayBaseUrl(), getSpecialistProvider(), isTransientProviderError(), ProviderConfigurationError (+8 more)

### Community 6 - "authorization.ts"
Cohesion: 0.14
Nodes (20): DELETE(), GET(), GET(), BindingRequest, POST(), GET(), RunNotFoundError, POST() (+12 more)

### Community 7 - "phase-b-backend.spec.ts"
Cohesion: 0.08
Nodes (16): repositoryReader, repositoryReaderInputSchema, RepositoryReaderOutput, repositoryReaderOutputSchema, repositoryReaderProfile, GithubFixtureState, MatrixMessage, ModelFixtureCall (+8 more)

### Community 8 - "Phase B — Backend first"
Cohesion: 0.07
Nodes (27): Approved sequencing and non-negotiable boundaries, Architecture and data flow, Concrete API contracts, Core entities and invariants, Event schema, Final end-to-end acceptance criteria, Matrix Agent Workspace Implementation Plan, Phase A — Mobile client second (+19 more)

### Community 9 - "WorkflowServices"
Cohesion: 0.09
Nodes (9): SpecialistProvider, CancellationController, InMemoryCancellationController, CheckpointStore, InMemoryCheckpointStore, InMemoryWorkflowEventSink, WorkflowEventSink, WorkflowServices (+1 more)

### Community 10 - "event-service.ts"
Cohesion: 0.13
Nodes (19): GET(), RunNotFoundError, streamRunEvents(), StreamRunEventsOptions, StreamTenant, TERMINAL_STATUSES, RUN_EVENTS, RunEventRow (+11 more)

### Community 11 - "RootNavigator.tsx"
Cohesion: 0.10
Nodes (17): MatrixSessionResponse, createMatrixClient(), MatrixClient, MatrixCredentials, ActiveRun, RootNavigator(), RootNavigatorProps, RootStackParams (+9 more)

### Community 12 - "RunComposerScreen.tsx"
Cohesion: 0.10
Nodes (12): ControlPlaneApi, RoomBinding, RoomBindingScreenProps, ExecutionMode, RunComposerScreen(), RunComposerScreenProps, SpecialistOption, styles (+4 more)

### Community 13 - "app-auth.ts"
Cohesion: 0.12
Nodes (18): acquireInstallationToken(), AuthorizedInstallation, base64Url(), createGithubAppJwt(), databaseInstallationStore, GithubAppAuthenticationError, GithubAppConfig, githubAppConfigFromEnv() (+10 more)

### Community 14 - "RunScreen.tsx"
Cohesion: 0.12
Nodes (13): ControlPlaneError, RunEventClient, CancellationState, RunScreen(), RunScreenProps, styles, EMPTY_DELIVERIES, isRecord() (+5 more)

### Community 15 - "scripts"
Cohesion: 0.09
Nodes (22): devDependencies, @playwright/test, typescript, vitest, typescript, vitest, name, private (+14 more)

### Community 16 - "index.ts"
Cohesion: 0.18
Nodes (17): ApiError, ApiErrorType, ALLOWED_PHASE_B_EVENT_TYPES, RUN_EVENT_TYPES, RunEvent, RunEventType, RunEventTypeLiteral, GithubReadQuery (+9 more)

### Community 17 - "delivery-worker.ts"
Cohesion: 0.15
Nodes (19): OUTBOX_MESSAGES, OutboxMessageRow, OutboxStatus, getMatrixDeliveryClient(), isMatrixTokenUnavailable(), isRetryableMatrixError(), resolveMatrixAccessToken(), deliverOne() (+11 more)

### Community 18 - "delivery-deduplication.test.ts"
Cohesion: 0.17
Nodes (8): MatrixDeliveryClient, MatrixSendError, MatrixSendParams, MatrixSendResult, MatrixTokenUnavailableError, SynapseDeliveryClient, FixtureMatrixClient, FixtureMatrixClient

### Community 19 - "workflows/support.ts"
Cohesion: 0.19
Nodes (10): ProviderPermanentError, WorkflowOutcome, buildWorkflowOptions(), makeClock(), makeServices(), makeSpecialist(), newRunId(), ProviderCallRecord (+2 more)

### Community 20 - "withTenant"
Cohesion: 0.18
Nodes (16): withTenant(), createRun(), CreateRunInput, getRun(), listRuns(), mapRunRow(), TenantContext, updateRunStatus() (+8 more)

### Community 21 - "executeRun"
Cohesion: 0.17
Nodes (11): assertDeadline(), buildTerminalSummary(), computeBackoff(), errorCodeOf(), executeRun(), finalizeTerminal(), InMemoryWorkflowRunStore, isTerminalStatus() (+3 more)

### Community 22 - "db/client.ts"
Cohesion: 0.23
Nodes (13): getDatabaseUrl(), getPool(), runMigrations(), splitSqlStatements(), appendEvent(), AppendEventInput, listEvents(), mapEventRow() (+5 more)

### Community 23 - "prompt-envelope.ts"
Cohesion: 0.14
Nodes (16): AppliedInjectionPolicy, applyPromptInjectionPolicy(), buildPromptEnvelope(), DEFAULT_PROMPT_INJECTION_MODE, detectPromptInjection(), escapeAttribute(), INJECTION_PATTERNS, InjectionFinding (+8 more)

### Community 24 - "matrix-token.ts"
Cohesion: 0.16
Nodes (13): MatrixSessionRequest, POST(), GET(), RoomSummary, createFixtureTokenCipher(), EncryptedToken, getMatrixClient(), getSynapseBaseUrl() (+5 more)

### Community 25 - "read-only.test.ts"
Cohesion: 0.16
Nodes (13): GET(), DELETE(), GET(), methodNotAllowed(), PATCH(), POST(), PUT(), RouteContext (+5 more)

### Community 26 - "oauth.ts"
Cohesion: 0.13
Nodes (11): createGithubOAuthService(), DEFAULT_PHASE_B_OAUTH_SCOPES, GithubOAuthConfig, githubOAuthConfigFromEnv(), GithubOAuthError, GithubOAuthStateError, OAuthSessionBinding, PHASE_B_OAUTH_SCOPE_ALLOWLIST (+3 more)

### Community 27 - "expo"
Cohesion: 0.11
Nodes (18): edgeToEdgeEnabled, package, predictiveBackGestureEnabled, expo, android, ios, name, newArchEnabled (+10 more)

### Community 28 - "TerminalResult.tsx"
Cohesion: 0.17
Nodes (15): DisplayStatus, eventLabel(), RunTimeline(), RunTimelineProps, specialistId(), styles, failedCount(), safeFailureCode() (+7 more)

### Community 29 - "contracts/package.json"
Cohesion: 0.11
Nodes (18): dependencies, zod, devDependencies, typescript, vitest, exports, typescript, vitest (+10 more)

### Community 30 - "message-renderer.ts"
Cohesion: 0.21
Nodes (16): isTerminalEventType(), RenderableEvent, renderMessage(), renderProgressMessage(), renderTerminalMessage(), summarizePayload(), summarizeTerminal(), TERMINAL_EVENT_TYPES (+8 more)

### Community 31 - "control-plane.ts"
Cohesion: 0.14
Nodes (13): ApiErrorBody, CancellationResponse, createControlPlaneClient(), expireControlPlaneSession(), FetchImplementation, FetchResponse, get(), MatrixDeliveryStatus (+5 more)

### Community 32 - "run-events.ts"
Cohesion: 0.13
Nodes (8): createRunEventClient(), normalizedBaseUrl(), RunEventConnection, RunEventsFetch, RunEventsResponse, SseFrame, TERMINAL_TYPES, expoFetch

### Community 33 - "dependencies"
Cohesion: 0.12
Nodes (17): dependencies, expo-crypto, @expo/metro-runtime, expo-secure-store, expo-status-bar, react, react-native-screens, @react-navigation/native (+9 more)

### Community 34 - "deliver-matrix-event.ts"
Cohesion: 0.17
Nodes (13): { GET, POST, PUT }, dispatchRunRequested(), getInngest(), inngest, RUN_REQUESTED_EVENT, RunRequestedEvent, RunRequestedEventData, deliverMatrixEvent (+5 more)

### Community 35 - "session-service.ts"
Cohesion: 0.21
Nodes (11): TokenCipher, createSession(), generateOpaqueId(), getSessionByOpaqueId(), getTokenCipher(), hashSessionId(), NewSession, revokeSession() (+3 more)

### Community 36 - "envelope-encryption.ts"
Cohesion: 0.22
Nodes (8): createKeyringFromEnv(), decrypt(), encrypt(), EnvelopeCipher, EnvelopeKey, EnvelopeKeyring, getDefaultEnvelopeCipher(), hexToBuffer()

### Community 37 - "compilerOptions"
Cohesion: 0.12
Nodes (15): ES2022, compilerOptions, declaration, declarationMap, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, lib (+7 more)

### Community 38 - "devDependencies"
Cohesion: 0.13
Nodes (15): devDependencies, jsdom, react-dom, react-native-web, @testing-library/react, @types/react, @types/react-dom, typescript (+7 more)

### Community 39 - "sse-replay.test.ts"
Cohesion: 0.18
Nodes (12): getAdminPool(), getMigrationsDatabaseUrl(), publishEvent(), resetDatabase(), seedWorkspaceIntegrations(), makeRun(), markTerminal(), ParsedFrame (+4 more)

### Community 40 - "include"
Cohesion: 0.14
Nodes (13): compilerOptions, noEmit, strict, types, extends, include, App.tsx, expo/tsconfig.base (+5 more)

### Community 41 - "session-store.ts"
Cohesion: 0.18
Nodes (5): ControlPlaneSession, createSessionStore(), SecureStoreAdapter, SESSION_COOKIE_KEY, MemorySecureStore

### Community 42 - "github/server.ts"
Cohesion: 0.17
Nodes (11): AuthorizationClass, fixture, fixturePath, json(), Mapping, mutationRequests, port, RecordedRequest (+3 more)

### Community 43 - "model/server.ts"
Cohesion: 0.18
Nodes (9): calls, ChatRequest, FixtureCall, fixtureOutput(), json(), port, priorOf(), sendCompletion() (+1 more)

### Community 44 - "include"
Cohesion: 0.18
Nodes (10): apps/control-plane/src/**/*.ts, apps/control-plane/src/**/*.tsx, apps/control-plane/test/**/*.ts, packages/contracts/src/**/*.ts, packages/contracts/test/**/*.ts, ./tsconfig.base.json, compilerOptions, noEmit (+2 more)

### Community 45 - "cancel/route.ts"
Cohesion: 0.27
Nodes (7): POST(), RunAlreadyTerminalError, RunNotFoundError, TERMINAL_STATUSES, appendEventWithClient(), enqueueMatrixDeliveryWithClient(), dispatchMatrixDeliveryRequested()

### Community 46 - "memory-repository.ts"
Cohesion: 0.36
Nodes (8): formatVector(), mapMemoryRow(), parseVector(), searchMemories(), storeMemory(), StoreMemoryInput, AGENT_MEMORIES, AgentMemoryRow

### Community 47 - "oauth-state.test.ts"
Cohesion: 0.24
Nodes (7): createDatabaseOAuthStateStore(), createOAuthStateService(), databaseOAuthLinkStore, getDefaultOAuthStateService(), OAuthLinkStore, keyring, stateService()

### Community 48 - "issues/route.ts"
Cohesion: 0.33
Nodes (7): DELETE(), methodNotAllowed(), PATCH(), POST(), PUT(), RouteContext, ValidationError

### Community 50 - "FrameReader"
Cohesion: 0.36
Nodes (3): FrameReader, parseFrame(), readAllSequences()

### Community 51 - "repositories/route.ts"
Cohesion: 0.43
Nodes (7): DELETE(), GET(), methodNotAllowed(), PATCH(), POST(), PUT(), authorizeInstallationAccess()

### Community 53 - "scripts"
Cohesion: 0.25
Nodes (8): scripts, android, export, ios, start, test, typecheck, web

### Community 54 - "RoomBindingScreen.tsx"
Cohesion: 0.38
Nodes (5): RoomSummary, errorMessage(), RoomBindingScreen(), styles, rooms

### Community 56 - "schema/github.ts"
Cohesion: 0.40
Nodes (4): GITHUB_INSTALLATIONS, GITHUB_LINKS, GithubInstallationRow, GithubLinkRow

### Community 57 - "rooms.ts"
Cohesion: 0.40
Nodes (4): ROOM_BINDINGS, RoomBindingRow, RoomRow, ROOMS

### Community 58 - "workspaces.ts"
Cohesion: 0.40
Nodes (4): WORKSPACE_MEMBERS, WorkspaceRow, WORKSPACES, WorkspaceStatus

### Community 59 - "mobile/package.json"
Cohesion: 0.40
Nodes (4): main, name, private, version

### Community 60 - "playwright.config.ts"
Cohesion: 0.40
Nodes (3): appDatabase, fixtureEnv, migrationsDatabase

### Community 61 - "Matrix Agent Workspace"
Cohesion: 0.40
Nodes (4): Delivery order, Matrix Agent Workspace, Mobile client, Phase B backend gate

### Community 62 - "Project agent memory"
Cohesion: 0.50
Nodes (3): Backend sharp edges, Maintaining this file, Project agent memory

### Community 63 - "Test fixtures"
Cohesion: 0.50
Nodes (3): Structure, Test fixtures, Usage

## Knowledge Gaps
- **319 isolated node(s):** `nextConfig`, `name`, `version`, `private`, `type` (+314 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `withTenant()` connect `withTenant` to `run-workflow.ts`, `session-service.ts`, `auth/support.ts`, `authorization.ts`, `sse-replay.test.ts`, `phase-b-backend.spec.ts`, `event-service.ts`, `cancel/route.ts`, `memory-repository.ts`, `app-auth.ts`, `delivery-worker.ts`, `db/client.ts`, `matrix-token.ts`, `oauth.ts`?**
  _High betweenness centrality (0.138) - this node is a cross-community bridge._
- **Why does `RunRequest` connect `index.ts` to `run-workflow.ts`, `control-plane.ts`?**
  _High betweenness centrality (0.074) - this node is a cross-community bridge._
- **Why does `expo-secure-store` connect `expo` to `session-store.ts`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **What connects `nextConfig`, `name`, `version` to the rest of the system?**
  _319 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.0425531914893617 - nodes in this community are weakly interconnected._
- **Should `read-client.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.10384615384615385 - nodes in this community are weakly interconnected._
- **Should `agent-config.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07152496626180836 - nodes in this community are weakly interconnected._