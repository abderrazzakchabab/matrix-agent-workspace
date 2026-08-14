# GitHub API fixture

`wiremock.json` holds the deterministic GitHub API stubs:

- Phase B read routes: GET stubs for installation repositories, issues, pull
  requests, pull-request files, and reviews.
- Phase C write routes: `POST /repos/acme/widget/issues` (create issue),
  `PATCH /repos/acme/widget/issues/7` (update issue),
  `POST /repos/acme/widget/issues/7/comments` (comment on issue), and
  `POST /repos/acme/widget/pulls/11/comments` (comment on pull request).

Tokens: `gho_fixture_read_token` classifies as OAuth and
`ghs_fixture_read_token` as installation; any `ghs_`-prefixed token is treated
as installation class. Non-GET requests to `/repos/*` or `/graphql` are
captured with their request bodies into `mutationBodies`.

Start WireMock on the fixture port:

```bash
docker run --rm --name matrix-test-github -p 4020:8080 \
  -v "$PWD/tests/fixtures/github/wiremock.json:/home/wiremock/mappings/github.json:ro" \
  wiremock/wiremock:3.13.1
```

A successful startup prints `port: 8080` (published locally as `4020`). The
Phase B read-only gate asserts the fixture receives no non-GET requests; the
Phase C write tests assert exactly the recorded mutations. The compose service
and Vitest runs use the small HTTP server in `server.ts`, which exposes
recorded requests, mutation requests, and mutation bodies via
`GET /__fixture/state`:

```bash
curl -fsS http://127.0.0.1:4020/__fixture/state
```

The expected result after the Phase B tests is an empty `mutationRequests`
array. The Vitest files also run a small HTTP server from the same mapping
document so focused and full test runs do not require Docker.
