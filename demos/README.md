# weave capability demos

Nine self-contained demos of what weave can do — **offline by default, no `ANTHROPIC_API_KEY`** (demo 9
needs Docker and skips cleanly without it). Peers use the `--fake` echo worker or deterministic code
skills; every demo runs in a throwaway workspace under `/tmp/weave-demos/`, never the engine repo.

```bash
npm run demos            # interactive menu — pick one
npm run demos -- 4       # run a single demo
npm run demos -- all     # run them all, then print a scorecard
```

Every demo **asserts its key result** and ends in a `PASS` / `FAIL` / `SKIP` verdict, so you never have
to eyeball the output to know it worked. `run.sh all` prints a scorecard at the end and exits non-zero
if anything failed (CI-friendly).

The launcher prefers the compiled `./weave` binary (and builds it once via Bun if missing) — demo 4
(the multi-process pool) requires it; the rest also work under `node --import tsx`.

| # | Demo | Shows | ADR |
|---|------|-------|-----|
| 1 | **Cooperative swarm** | two peers share one log, claim each task exactly once, split the work — no coordinator | 0001/0002 |
| 2 | **Skill routing** | tasks dispatched to matching code skills (greeter, calc) with an echo fallback — weave is domain-agnostic | 0012/0016 |
| 3 | **Loops** | a scheduler re-declares a task routed to a skill each tick (`--once` runs a single pass) | 0008 |
| 4 | **Pool resilience** | a supervisor restarts a crashed worker, and orphaned workers self-terminate when it's SIGKILL'd | — |
| 5 | **Memory compaction** | a long log folds into one durable snapshot event; reads stay correct and cheap | 0007 |
| 6 | **Federated convergence** | two replicated hosts partition, double-claim, heal, and converge on one deterministic winner | 0009 |
| 7 | **Knowledge + search** | completed results become a knowledge graph; hybrid BM25 search over accumulated knowledge | 0020/0021 |
| 8 | **Architecture gate** | `weave doctor` enforces the hex dependency cone — a boundary violation fails the build | 0015 |
| 9 | **Container sandbox** | a skill in a `--network none --read-only --cap-drop ALL` Docker container — the kernel blocks the network, yet a granted tool still round-trips via stdio RPC (needs Docker) | 0018 |

Each demo is a small bash script in this directory (plus `federated.mts` for #6, `sandbox.mts` for #9,
and the code skills in `skills/`); read them as worked examples. `lib.sh` holds the shared helpers.
