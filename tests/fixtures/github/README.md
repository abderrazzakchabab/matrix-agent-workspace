# Read-only GitHub API fixture

`wiremock.json` contains only GET stubs for installation repositories, issues,
pull requests, pull-request files, and reviews. It intentionally contains no
GitHub mutation stub.

Start WireMock on the fixture port:

```bash
docker run --rm --name matrix-test-github -p 4020:8080 \
  -v "$PWD/tests/fixtures/github/wiremock.json:/home/wiremock/mappings/github.json:ro" \
  wiremock/wiremock:3.13.1
```

A successful startup prints `port: 8080` (published locally as `4020`). Verify
that the fixture has received no non-GET requests with:

```bash
curl -fsS http://127.0.0.1:4020/__admin/requests \
  | jq '[.requests[] | select(.request.method != "GET")] | length'
```

The expected result after the Phase B tests is `0`. The Vitest files also run a
small HTTP server from the same mapping document so focused and full test runs
do not require Docker.
