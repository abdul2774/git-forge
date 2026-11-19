# git-forge — a GitHub-compatible git forge in one Node process

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/abdul2774/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/abdul2774/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

An entry for [the github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01) on
[make.fun](https://make.fun/bounty/github-core-clone-01): a single-process, dependency-free
GitHub-compatible forge. It serves git smart HTTP (protocol v2 and v0), the REST v3 resources,
GraphQL v4 and an MCP endpoint from one in-memory store — no database, no `git` binary, Node
standard library only. The code is split by surface (`githttp.ts`, `rest.ts`, `graphql.ts`,
`mcp.ts`) over a shared store (`store.ts`, `domain.ts`, `gitobj.ts`); the contract it is built
against lives in [AGENTS.md](AGENTS.md).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http` and its own modules only, and the trial has no package manager and
no internet.

## Check it locally

```sh
npm test        # the full 120-check conformance suite against a fresh forge process
npm run bench   # the same, plus the four timed workloads (push, clone, read, write)
```

Both wrap the competition kit's own suite runner via `tools/run-checks.sh` (set `FORGE_KIT_DIR`
if the kit lives somewhere else).

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold the request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. Whether a missing or a wrong token
is refused is part of the protocol checks.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle implementation described above.
- `app.ts`: composition — builds the HTTP server from the parts.
- `web.ts`: HTTP plumbing: routing, JSON in/out, headers.
- `store.ts`: the in-memory store (repos, issues, pulls, objects).
- `domain.ts`: shared domain logic used by more than one surface.
- `gitobj.ts`: the git object model and packfile read/write.
- `githttp.ts`: git smart HTTP: advertisement, upload-pack, receive-pack.
- `rest.ts`: REST v3. `graphql.ts`: GraphQL v4. `mcp.ts`: the MCP endpoint.
- `tools/`: the local conformance/perf harness (`npm test`, `npm run bench`).
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.
