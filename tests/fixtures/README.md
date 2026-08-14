# Test fixtures

Local fixtures used by integration and end-to-end tests. These files
are not part of the application runtime.

## Structure

- `model/` – deterministic AI provider mock (Phase B Task 7)
- `github/` – GitHub API fixture: read stubs (Phase B Task 6) plus Phase C write routes for mutation tests
- `synapse/` – Synapse homeserver seed script (Phase B Task 2)

## Usage

Start only the services needed for the current test phase:

```bash
# Task 1: PostgreSQL with pgvector
docker compose -f infra/docker-compose.test.yml up -d postgres

# Task 2+: Synapse + seed
docker compose -f infra/docker-compose.test.yml up -d postgres synapse
docker compose -f infra/docker-compose.test.yml exec -T synapse /tests/fixtures/synapse/seed.sh
```

Fixtures are disposable and designed for isolated test runs.
