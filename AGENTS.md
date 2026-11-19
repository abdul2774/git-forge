# AGENTS.md — the contract for working on this forge

This repository is a GitHub-compatible git forge, built for make.fun's
**github-core-clone-01** bounty. It is graded by a sealed suite that drives it
as a client (git smart HTTP, REST v3, GraphQL, MCP) and scores 1,000 points:
120 conformance checks (git 30, pulls 20, graphql 20, repos 15, issues 15,
mcp 15, protocol 5) worth 600, the MCP column worth 200, and four timed
workloads worth 200. A prize requires beating the house reference forge
(≈900 points), so conformance must stay at 120/120 and performance is not
optional. Read this file before changing anything.

## Entrypoint contract

- `main.ts` is the competition starter's lifecycle file. **Never modify it.**
  It binds an ephemeral port (`listen(0)`, never 8080), POSTs `{"port"}` to
  `$MAKEFUN_ENV_URL/register`, polls `GET $MAKEFUN_ENV_URL/done`, and exits 0.
- Boot budget is 20 s to register; `GET /healthz` must answer 200
  `{"ok": true}`.
- `/bot` (this repository at the entered commit) is **read-only** in the
  trial pod; the only writable location is `/tmp`. All state is therefore
  in-memory, created fresh by the suite during each trial. Limits: 2 CPUs,
  1024 MB RAM, 256 processes, 900 s wall, no network beyond the suite.

## Hard rules

- **Node standard library only.** No npm dependencies, no install step, no
  native addons. If it is not in `node:*`, it does not ship.
- **Erasable TypeScript only** (the runtime uses type-stripping): no enums,
  no namespaces, no parameter properties, no `import =`. Local imports carry
  `.ts` extensions.
- **Never shell out to an external git CLI or any external binary.** Git
  objects, packfiles and the smart-HTTP protocol are implemented in-process
  (`gitobj.ts`, `githttp.ts`). Pack *reading* must fully resolve OFS and REF
  deltas; pack *writing* is plain objects only, no delta encoding.
- **Determinism.** Response data never depends on `Date.now()` or
  `Math.random()`: timestamps derive from `MAKEFUN_TRIAL_NOW` plus monotonic
  counters, and ids come from counters. The suite replays fixed scenarios;
  a wall-clock value in a response is a failing check waiting to happen.
- **Fixed identity.** The suite's token owner is always login `adaiversen`
  (id 1000). Repositories are keyed by `(owner, name)`; a repository under
  any other owner is **404, never 403**.
- Authorship discipline: write code with file-editing tools, never by
  piping text through the shell; commit per working stage with a
  descriptive message.

## Wire discipline (the protocol checks, and every surface)

- Every REST reply is `application/json` — never HTML. Unknown routes
  answer **404** with a JSON body; a malformed JSON request body answers
  **400**. Every reply carries a non-empty `X-GitHub-Request-Id` header
  (a counter string suffices).
- Error bodies follow GitHub's shape: a JSON object with a **string
  `message`** field.
- A missing or wrong bearer token (`MAKEFUN_SHOP_TOKEN`) answers **401**
  on REST, GraphQL and MCP alike.

## Module map — keep the surfaces isolated

| file | owns |
|---|---|
| `main.ts` | trial lifecycle (immutable, see above) |
| `app.ts` | composition: builds the HTTP server from the parts |
| `web.ts` | HTTP plumbing: routing, JSON in/out, headers |
| `store.ts` | the in-memory store (repos, issues, pulls, objects) |
| `domain.ts` | shared domain logic used by more than one surface |
| `rest.ts` | REST v3: repos, issues, pulls, contents, git refs |
| `githttp.ts` | git smart HTTP: advertisement, upload-pack, receive-pack |
| `gitobj.ts` | git object model and packfile read/write |
| `graphql.ts` | GraphQL v4 endpoint and its mini engine |
| `mcp.ts` | the MCP endpoint and its tools |

A change inside `githttp.ts` must not require changes in `rest.ts` or
`graphql.ts`. Surfaces share state only through `store.ts` / `domain.ts`.

## Surface contracts (the parts the suite pins down)

- **Git smart HTTP.** Upload-pack speaks **protocol v2** (`ls-refs`,
  `fetch` including shallow/deepen, `side-band-64k`). Receive-pack is v0
  with `report-status`: each ref reports `ok` or `ng` independently, the
  non-fast-forward reason string is exactly `non-fast-forward`, and only
  the accepted refs move. `delete-refs` is supported.
- **REST v3.** `PUT contents` on an unborn repository creates its first
  real git commit. Pull-request merge is **squash-only** (other methods
  answer 405); merged content must read back from the base branch;
  a conflicting merge answers 405.
- **GraphQL.** Global ids are **opaque, stable, and round-trip** (a node
  id handed out by a query must resolve back through `node(id:)`).
  Pagination is cursor-based. Introspection must cover `Issue`,
  `PullRequest`, `Repository` and `SearchType`. Batched operations are
  supported.
- **MCP.** One shared store with REST: an object created through MCP reads
  back over REST with the same id, and vice versa. `tools/list` output is
  **byte-identical across calls**. Either the modern `server/discover`
  handshake (2026-07-28) or the legacy `initialize` handshake is accepted;
  a call without `Authorization` answers 401.

## Performance budgets

Each workload scores 25 points at its reference time `T_ref` and 50 at
`T_ref / 4`:

| workload | fixed work | T_ref |
|---|---|---|
| push | 200 sequential receive-pack pushes | 1641 ms |
| clone | 50 concurrent depth-1 clones of a 200-commit repo | 267 ms |
| read | 2,000 GETs of one issue on keep-alive | 2760 ms |
| write | 200 issue POSTs | 349 ms |

The caching shape that holds these numbers: pack bytes cached per
tip/send-set (the clone storm re-sends identical packs), the serialised
issue body cached for the read workload, and O(1) issue insertion.

## Test loop

- `npm test` — the full 120-check conformance suite against a **fresh**
  forge process (the suite is stateful per process; numbers from a reused
  instance are meaningless).
- `npm run bench` — the same, plus the four performance workloads.

Both wrap the competition kit's own `sdk/run.ts` — byte-identical to the
sealed grader — via `tools/run-checks.sh`. Set `FORGE_KIT_DIR` if the kit
lives somewhere else. There is no Docker on this machine; the sdk loop is
the fast path, and a full trial can be run through the kit's
`program/env/server.mjs` plus `program/scorer/` when needed.
