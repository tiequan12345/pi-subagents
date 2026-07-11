# Plan: Orca terminal mux backend for pi-subagents

Status: **proposed** (not yet implemented)
Target: `pi-subagents` v2.5.x
Owner: TBD
Revision: 2 — incorporates reviewer feedback (RPC failure semantics,
child-side backend propagation, acceptance criterion, missed edit sites).

---

## 1. Why this exists

We run `pi` inside the Orca app. The pi-subagents extension supports five
interactive mux backends — Herdr, cmux, tmux, zellij, WezTerm — but **Orca is
none of them**. Orca owns its own terminal/PTY runtime behind the app process
and exposes it through the `orca` CLI, not through any of the env vars
(`TMUX`, `ZELLIJ`, `WEZTERM_UNIX_SOCKET`, `CMUX_SOCKET_PATH`, Herdr probe)
that pi-subagents checks.

Symptom: an agent with `mode: interactive` is launched, but the child runs
**headless in the background** instead of in a visible Orca pane. The
interactive surface is silently never created.

**Definition of done (observable):** inside a running Orca app, launching an
agent with `mode: interactive` opens a **visible Orca pane** containing the
child `pi` session — *not* a headless background child. This is the one
acceptance criterion that proves the §1 bug is fixed; the mux smoke alone
(§6.3) does not.

### Root cause (confirmed by code reading)

In `src/tools/subagent-tools.ts`, `launchOneSubagent`:

```js
const isBackground = effectiveParams.background ?? agentDefs?.mode === "background";
if (isBackground) { /* background child */ }
else if (ctx.hasUI && isMuxAvailable()) { /* interactive surface */ }
else { /* SILENT FALLBACK: launchBackgroundSubagent */ }
```

`isMuxAvailable()` (in `src/mux/core.ts`) returns true only when one of the
five backend env probes passes. Inside Orca, none pass, so every interactive
launch hits the third branch and becomes a background child. There is no
error, no warning — the mode the user asked for is discarded.

A repo-wide grep for `orca` across `src/**.ts` returns **zero matches**. Orca
is entirely unhandled.

### The fix in one sentence

Add Orca as a sixth mux backend that talks to `orca terminal ...` (the same
CLI the `orca-cli` skill documents), so interactive children open in real
Orca-managed panes — which, as a side benefit, are owned by the Orca runtime
and so may **persist visually as orphaned panes** if the parent `pi` crashes
(see §5.11 for an honest accounting of what does and does not survive).

---

## 2. Scope of this plan

**In scope (Option A):**
- Detect that we are running inside an Orca-managed terminal.
- Implement the pi-subagents mux surface contract for Orca: create surface,
  send command, read screen, close surface, rename tab/workspace.
- Wire Orca into the backend-selection switch in `core.ts` / `surfaces.ts` /
  `io.ts`.
- Unit tests mirroring the Herdr test suite.
- A live smoke script mirroring `test:live-herdr-mux`, behind an opt-in guard.
- README + AGENTS.md notes.

**Explicitly out of scope (deferred, tracked as Option B):**
- Bridging the child→parent protocol (`caller_ping`, `subagent_done`,
  `heartbeat`, `worker_done`) onto `orca orchestration send/check/reply/ask`.
- Task/dispatch/gate DAG parity with Orca's orchestration layer.
- Any change to the in-process result router or session JSONL model.

Rationale: Option A alone unblocks the reported bug and delivers persistence
(surfaces are Orca-owned). Option B is only worth the complexity if, after A,
parent-restart result loss or richer inter-agent messaging becomes a real
pain. Ship A, measure, then decide on B.

---

## 3. Background: the contract any mux backend must satisfy

Every backend implements the same handful of operations against a **surface
handle** (an opaque string identifying one terminal pane). The handle is
stored on `RunningSubagent.surface` and passed back into the io/poll helpers.
For Herdr the handle is a pane id; for tmux it's `%<n>`; for Orca it will be
the Orca **terminal handle** (`result.terminal.handle` from
`orca terminal create --json`).

### 3.1 Surface lifecycle

| Operation | Pi-subagents function | What each backend provides |
|---|---|---|
| Create a pane | `createSurface(name)` / `createSurfaceSplit(...)` in `src/mux/surfaces.ts` | Spawns a new pane, returns its handle, optionally titles it |
| Send a command | `sendCommand` / `sendShellCommand` in `src/mux/io.ts` | Types text + Enter into the pane |
| Read screen | `readScreen` / `readScreenAsync` in `src/mux/io.ts` | Returns recent visible lines (used for exit-sentinel polling) |
| Close pane | `closeSurface` in `src/mux/io.ts` | Kills the pane |
| Rename | `renameCurrentTab` / `renameWorkspace` in `src/mux/surfaces.ts` | Titles the tab/window |

### 3.2 How completion is detected (critical) — and why Orca is different

A child does **not** signal completion through mux events. The watcher
(`src/runtime/interactive-watch.ts` → `pollForExit` in `src/mux/poll.ts`)
detects exit by **polling three sources** every 1s, in order:

1. **`.exit` sidecar file** (`<session>.exit`) — written by the child's
   protocol helper (`src/tools/subagent-done.ts`) on done/ping/error. This is
   the **primary** signal. Carries `{type, outputTokens, ...}`.
2. **Done-sentinel file** — the shell `trap ... EXIT` writes
   `__SUBAGENT_DONE_<code>__` to a sentinel file. Fallback when the sidecar
   is absent.
3. **Screen scrape** — `readScreenAsync(surface, 5)` is grepped for
   `__SUBAGENT_DONE_<code>__` (the trap also `tee`s the sentinel into the
   pane). Last-resort fallback.

**This loop is the crux of the Orca divergence.** For tmux/wezterm/zellij,
`readScreenAsync` is a local syscall (`capture-pane`, `get-text`, etc.) that
essentially never fails transiently. Orca's `terminal read` is an **RPC to
the app process** — it can stall or fail while the child is still running
(app busy, mid-GC, momentarily unresponsive). Look at `pollForExit`
(poll.ts): when `readScreenAsync` throws, the catch re-checks the
sidecar/sentinel **once**, and if neither is present it throws
`"Failed to read subagent surface while polling for exit"` — which
**permanently aborts** the watcher.

That permanent-abort behavior is correct for local-CLI backends. It is a
**bug magnet for an RPC backend**: a single transient RPC miss while the
child is still healthy (no sidecar yet) would kill the watcher for a child
that keeps running. Orca must therefore distinguish two failure classes:

- **Stale handle** (`terminal_handle_stale` / `terminal_not_found`) — the
  child's pane is gone. This is a *real* completion signal. Throw, so
  `pollForExit` falls back to sidecar/sentinel; if those are also absent the
  child died without writing one and the result is a failure (exit ≠ 0).
- **Transient failure** (timeout, RPC error, app momentarily unresponsive) —
  the child is likely still alive. **Return `""`, do not throw.** The poller
  simply continues to the next 1s tick. This avoids killing a healthy child
  on a flaky read.

See §5.6 for the implementation contract this implies.

### 3.3 How `sendShellCommand` works for backends that need staging

For cmux and Herdr, `sendShellCommand` stages the (potentially huge, quoted)
command into a temp shell script, sends `<scriptPath>; rm -f <scriptPath>`,
and removes the temp file on failure (`src/mux/io.ts`). tmux/wezterm/zellij
send the raw command directly. Orca should use the **staged** path, matching
Herdr: `orca terminal send --text` with a giant raw command is fragile, and
the pi launch command includes heavy env prefixing + many escaped args.

**Pre-implementation confirmation (one live check):** this assumes
`orca terminal create` yields an interactive shell (like Herdr's panes) such
that `<scriptPath>; rm -f <scriptPath>` and the `cd <cwd> &&` prefix behave
as expected. The §1 side-benefit note says panes are bare shells — confirm
once against a live Orca pane, since the entire quoting strategy rests on it.

**`sendCommand` newline/enter semantics — must be decided by live probing**
(see §8 Q3). Three explicit test cases to cover once decided:
1. normal command (no trailing newline)
2. empty command (bare Enter — used by some backends to re-prompt)
3. command already ending in `\n` (no double-Enter)

### 3.4 Backend selection

`getMuxBackend()` in `src/mux/core.ts` resolves the active backend:
1. `PI_SUBAGENT_MUX` explicit override → validates that backend's probe.
2. Otherwise auto-detect in order: herdr → cmux → tmux → zellij → wezterm.

Each backend has two helpers: `is<Backend>RuntimeAvailable()` (cheap env
check) and `is<Backend>Available()` (public, sometimes heavier). The cheap
check gates the expensive one.

### 3.5 The split-path subtlety

`createSurfaceSplit` is the **fallback when no backend is selected** (the
default arm of `createSurface`). It calls `requireMuxBackend()` which throws
if none is available. Every backend must therefore implement both
`createSurface` and a split variant, even if split degrades (Herdr only
supports right/down and throws on left/up).

---

## 4. Orca CLI surface map (from the `orca-cli` skill)

The Orca CLI commands this backend will use. All support `--json`.

| Pi-subagents op | Orca command | Notes |
|---|---|---|
| Detect runtime | `orca status --json` | `result.runtime.running === true` |
| Where am I | `orca worktree current --json` / `orca terminal list --json` | Resolve the active worktree + current terminal handle |
| Create pane | `orca terminal create --worktree active --title <name> --json` | Returns `result.terminal.handle`. Bare shell (we send the `pi` command ourselves) |
| Send command | `orca terminal send --terminal <handle> --text <cmd> --enter --json` | Staged script path goes here |
| Read screen | `orca terminal read --terminal <handle> --json` | Returns `result.terminal.tail` (array of screen lines, NOT `result.content`) |
| Close pane | `orca terminal close --terminal <handle> --json` | Idempotent on already-closed |
| Rename tab | `orca terminal rename --terminal <handle> --title <name> --json` | |
| Split pane | `orca terminal split --terminal <handle> --direction horizontal\|vertical --json` | Only right/down map cleanly (like Herdr) |
| Rename workspace | `orca worktree set --worktree active --display-name <title> --json` | Gated by opt-in env var (see §5.8) |

**Not used:** `orca terminal wait --for tui-idle`. The existing
`waitForInteractivePrompt` (`src/runtime/wiring.ts:30`) is a generic
readScreen-stabilize loop (poll every 300ms until the screen stops changing,
15s cap) and already tolerates read failures via `.catch(() => "")`. It is
backend-agnostic and works as-is for Orca. Adding a per-backend `wait`
abstraction is YAGNI — do not wire `terminal wait` in.

**Known gotchas from the skill:**
- `terminal read` returns `result.terminal.tail` as an **array of lines**;
  `readScreen` must `.join("\n")` and tail to the requested line count.
- Terminal handles are **runtime-scoped** — if Orca restarts, a stored handle
  goes stale and commands return `terminal_handle_stale`. `closeSurface` and
  `readScreenAsync` must treat stale-handle errors as non-fatal (pane already
  gone / poller falls back to sidecar).
- `--terminal` is optional and defaults to the active terminal in the current
  worktree; we must **always pass the explicit handle** since we manage many
  children.
- For long screen output the skill mentions cursor pagination
  (`oldestCursor`/`nextCursor`); we only need the recent tail for sentinel
  polling, so plain `terminal read` suffices.

---

## 5. Design

### 5.1 File layout (follows repo ownership rules in AGENTS.md)

New source files:
- `src/mux/orca.ts` — Orca CLI thin client: spawn `orca ... --json`, parse
  envelope (`{result: {...}}` or `{error: {code, message}}`), typed accessors
  for the commands above. Mirrors `src/mux/herdr.ts` structurally.
- `src/mux/orca-surfaces.ts` — implements the surface contract on top of the
  client. Mirrors `src/mux/herdr-surfaces.ts`.

Modified source files:
- `src/mux/core.ts` — **three** edit sites:
  1. `MuxBackend` union: add `"orca"`.
  2. `muxPreference()` (the hardcoded literal whitelist that gates
     `PI_SUBAGENT_MUX`) — add `"orca"` to the accepted set. **This is easy
     to miss** and without it `PI_SUBAGENT_MUX=orca` silently does nothing.
  3. Detection: add `isOrcaRuntimeAvailable()` / `isOrcaAvailable()` and wire
     Orca into `getMuxBackend()` order + `muxSetupHint()`.
- `src/mux/surfaces.ts` — route `createSurface` / `createSurfaceSplit` /
  `renameCurrentTab` / `renameWorkspace` to the Orca impl when backend is
  `"orca"`. **Critical:** `createSurfaceSplit`'s default arm currently falls
  through to `createHerdrSplit`; an Orca arm must be explicit or Orca splits
  silently route to Herdr. Mirror Herdr's split-direction restriction (only
  right/down; throw on left/up).
- `src/mux/io.ts` — add Orca arms to `sendCommand`, `sendShellCommand`,
  `readScreen`, `readScreenAsync`, `closeSurface`. Orca uses the staged-shell
  path (include `"orca"` alongside `"cmux"` and `"herdr"` in the
  `sendShellCommand` guard).
- `src/mux.ts` (barrel) — no change required; it already re-exports the
  generic surface/io functions. Confirm nothing Orca-specific needs exporting.

Minimal change to `src/launch/*`:
- `src/launch/interactive.ts` — **one line**: inject `PI_SUBAGENT_MUX=orca`
  into child env when the selected backend is Orca (see §5.10). Required for
  reliable child-side detection.

No changes to: `src/runtime/*`, `src/tools/*`, `src/types.ts`, `src/session/*`,
`src/agents/*`, `src/artifact-storage.ts`.
The new backend is transparent to everything above the mux layer plus that
one env-injection line — that is the whole point of the abstraction.

New test files:
- `test/mux/orca.test.ts` — fake-Orca contract suite, mirroring
  `test/mux/herdr.test.ts`.
- `test/launch/orca-interactive-launch.test.ts` — launch-parity suite
  mirroring `test/launch/herdr-interactive-launch.test.ts`.

Modified:
- `test/test.ts` — register the two new suites.
- `package.json` — add `test:live-orca-mux` (and optionally
  `test:live-orca-pi`) scripts mirroring the Herdr live scripts; add `orca`
  to `knip.ignoreBinaries`.
- `AGENTS.md` — note Orca detection + the live-test opt-in env var.
- `README.md` — add Orca to the mux backends list and the env-var table.

### 5.2 Detection strategy

Detection is the riskiest part because Orca detection may require a
subprocess (`orca status --json`) and `getMuxBackend()` is called on **every
io op** — and `pollForExit` calls `readScreenAsync → requireMuxBackend()`
**every 1s**. A subprocess-per-tick detection would spawn an `orca status`
on every poll tick on top of the read itself. That makes detection design a
correctness/perf requirement, not an optimization.

**Decision tree (resolve the branch by probing a live Orca terminal first —
see §8 Q1, which subsumes the former tmux-precedence question):**

```
Does Orca export an env var into its terminal shells?
  (probe: env | grep -i orca inside an Orca pane)
├─ YES (e.g. ORCA_WORKTREE_ID / ORCA_TERMINAL_HANDLE / ORCA_SESSION_ID)
│   • Cheap check: env var present + orca on PATH.
│   • Heavy check (only if cheap passes): orca status --json →
│     result.runtime.running === true, plus result envelope shape asserted
│     (not just exit 0 — `orca` is a generic binary name).
│   • If env var set AND TMUX also set (Orca embeds tmux), the env var wins
│     detection; tmux is never reached. §8 Q2 dissolves into Q1.
└─ NO
    • Cheap check: orca on PATH only (still risky — generic name).
    • Heavy check: orca status --json (envelope asserted) +
      orca worktree current --json (confirm we're INSIDE Orca, not just
      that `orca` is installed on a dev box).
    • REQUIRED: cache the resolved backend for the session so the per-tick
      subprocess cost is paid once. Add a module-level cache in core.ts
      keyed by process; invalidate on session_shutdown.
```

**Regardless of branch, add:**
- **Session-scoped caching of `getMuxBackend()`'s result.** Even the
  env-var branch benefits (it's read on every io op). Cache once per
  parent pi process; clear on `session_shutdown`. This removes the
  per-tick detection cost entirely.
- **Envelope-shape assertion.** `isOrcaAvailable` must require
  `result.runtime.running === true`, not just exit 0, because unrelated
  CLIs named `orca` exist.

**Detection order in `getMuxBackend()`:** place Orca **after Herdr, before
cmux**. If §8 Q1 reveals `TMUX` leaks into Orca panes, place Orca **before
tmux** so it wins the embedded-tmux race. (If an Orca env var exists, order
is less sensitive — the env-var gate handles it — but the cache still pays
for itself.)

`PI_SUBAGENT_MUX=orca` forces Orca and must validate via
`isOrcaRuntimeAvailable()`. Note this requires the §5.1 `muxPreference()`
edit to even be accepted.

### 5.3 Surface handle format

The Orca handle is the string from `result.terminal.handle`. Store it
verbatim on `RunningSubagent.surface`. No prefixing needed (unlike Zellij's
`pane:<id>`), because Orca handles are unambiguous strings.

### 5.4 `createSurface` for Orca

```
createOrcaSurface(name):
  wt = orca worktree current --json   → result.worktree.id / selector "active"
  res = orca terminal create --worktree active --title <name> --json
  handle = res.result.terminal.handle
  return handle
```

Use `--worktree active` (not an explicit id) so the child lands in the same
worktree as the parent pi — matching the skill's guidance for "fresh agent in
the current checkout." The parent's cwd is inherited by the pane; the launch
command's own `cd <cwd> &&` prefix (already in `interactive.ts`) ensures the
child shell is in the right directory regardless.

Splits: Orca supports `orca terminal split --terminal <handle> --direction
horizontal|vertical --json`. Like Herdr, only right/down (horizontal/vertical)
map cleanly; throw on left/up with the same "unsupported direction" error
Herdr uses, so behavior is consistent.

**`fromSurface=undefined` semantics (must decide).** Existing generic callers
(`createSurfaceSplit`'s default arm) allow `fromSurface` to be omitted.
`orca terminal split` requires a `--terminal` handle. Decide explicitly:
either (a) resolve the active terminal via `orca terminal list --json` and
split it, or (b) throw `"createOrcaSplit requires fromSurface"`. Prefer (b)
— simpler, and the only real caller (`createSurfaceSplit`) always supplies a
`fromSurface` for a meaningful split. Document the choice and add a test.

### 5.5 `sendCommand` / `sendShellCommand` for Orca

- `sendCommand(surface, command)`:
  `orca terminal send --terminal <handle> --text <command>
 --enter --json`.
  **Newline/`--enter` semantics must be decided by live probing (§8 Q3)**
  before committing — double-Enter bugs here are subtle. The skill always
  pairs `--text` with `--enter`; verify whether `--enter` alone (with empty
  `--text`) sends a bare Enter, matching how `sendCommand(surface, "")` is
  used for re-prompting in other backends. If not, special-case empty
  commands. Cover three explicit test cases once decided:
  1. normal command (no trailing newline)
  2. empty command (bare Enter)
  3. command already ending in `\n` (no double-Enter)
- `sendShellCommand`: route through the **staged-shell** path (add `"orca"`
  to the `backend !== "cmux" && backend !== "herdr"` guard). The pi launch
  command is large and heavily escaped; staging avoids quoting bugs and
  matches Herdr.
- **Exec timeout on every `orca` invocation.** Unlike local-CLI backends,
  `orca terminal send` is an RPC that can hang if the app is unresponsive.
  Pass a timeout to `spawnSync`/`execFile` (e.g. 5–10s) and treat timeout as
  a transient failure (per §5.6), not a crash.

### 5.6 `readScreen` / `readScreenAsync` for Orca — transient vs stale

This is where Orca diverges from every local-CLI backend (see §3.2).

```
res = orca terminal read --terminal <handle> --json   (timeout 5-10s)
tail = res.result.terminal.tail        # ARRAY of lines
text = tail.join("\n")
return tailLines(text, lines)          # reuse existing helper
```

Handle the envelope exactly as the skill warns: parse `result.terminal.tail`,
**not** `result.content`/`result.text`. Sync version uses `spawnSync`; async
uses `execFile` (mirror `herdr.ts`'s `runHerdrText` / `runHerdrTextAsync`).

**Failure classification (the core contract):**

| Failure | Detected by | `readScreenAsync` behavior |
|---|---|---|
| **Stale handle** | error code `terminal_handle_stale` / `terminal_not_found` | **throw** — `pollForExit` falls back to sidecar/sentinel; if those are also absent the child died without writing a sidecar → result is failure (exit ≠ 0) |
| **Transient** | timeout, generic RPC error, app momentarily unresponsive | **return `""`, do NOT throw** — poller continues to next 1s tick; a healthy child is not killed by a flaky read |

Rationale: `pollForExit`'s catch re-checks sidecar/sentinel **once** then
throws permanently. For local backends that's fine (reads never fail
transiently). For an RPC backend it's a bug magnet — one transient miss while
the child is still running (no sidecar yet) would abort the watcher for a
healthy child. Returning `""` on transient failures keeps the poller alive.

**`readScreen` (sync) behavior — must also be intentional.** It's called by
direct user-facing paths (e.g. widget diagnostics), not just the poller.
Apply the same stale/transient split: stale → throw (surfaces the real
problem to the user); transient → return `""` (avoids spurious errors).
Add tests for both branches on both sync and async.

### 5.7 `closeSurface` for Orca

```
orca terminal close --terminal <handle> --json
```

Swallow `terminal_handle_stale` / already-closed errors (mirror Herdr's
`isAlreadyClosedHerdrPane`). Orca may return a stale error after restart; we
treat "already gone" as success.

### 5.8 `renameCurrentTab` / `renameWorkspace` for Orca

- `renameCurrentTab(title)`:
  `orca terminal rename --terminal <currentHandle> --title <title> --json`.
  The current handle comes from the active terminal — but note this function
  runs in the **child** process context (it's called by `set_tab_title`). The
  child knows its own handle via the env var we inject at launch
  (`PI_SUBAGENT_SURFACE` already carries the Orca handle). Use that rather
  than re-resolving "current."
  **Pre-implementation verification (one grep):** confirm in
  `src/launch/interactive.ts` that `PI_SUBAGENT_SURFACE` is set verbatim from
  the resolved surface (the `envVars` map around line 151). This de-risks the
  "no changes to `src/launch/*`" claim for §5.8 specifically — but note that
  §5.10 *does* require a one-line launch change, so the "no launch changes"
  framing in §5.1 is now relaxed to "minimal, explicitly listed."
- `renameWorkspace`: Orca's worktree display name. Use
  `orca worktree set --worktree active --display-name <title> --json`. Gate
  behind an env opt-in (`PI_SUBAGENT_RENAME_ORCA_WORKTREE=1`, default off) to
  match the conservative precedent of `PI_SUBAGENT_RENAME_TMUX_WINDOW`.

### 5.9 Error envelope parsing

Orca CLI returns `{ "error": { "code": "...", "message": "..." } }` on
failure and `{ "result": { ... } }` on success (standard RPC envelope, same
shape Herdr uses). Reuse the exact error-parsing pattern from `herdr.ts`
(`formatHerdrApiError` → `formatOrcaApiError`, `HerdrCommandError` →
`OrcaCommandError`) so error messages are uniform and code-stable.

Export a helper to classify stale vs transient from an `OrcaCommandError`'s
`code`, since §5.6's read contract and §5.7's close swallow both depend on
it: `isOrcaStaleHandle(error)` returns true only for `terminal_handle_stale`
/ `terminal_not_found`.

### 5.10 Child-side backend propagation (REQUIRED)

The child is a **fresh `pi` process** that re-runs `getMuxBackend()` for its
own needs (`set_tab_title` → `renameCurrentTab`, and any future interactive
op). If the parent detected Orca via the §5.2 heavy path (env var absent),
the child must re-run that detection — and if detection is unreliable in the
child (e.g. cwd differs, or a race during launch), the child may detect no
backend or the wrong one.

**Fix (one-line launch change):** when the parent selects Orca, inject
`PI_SUBAGENT_MUX=orca` into the child env in `src/launch/interactive.ts`
(alongside the existing `PI_SUBAGENT_SURFACE` line, ~line 151). The child's
`muxPreference()` then returns `"orca"` directly, validated by
`isOrcaRuntimeAvailable()`. This guarantees child-side detection matches the
parent regardless of how the parent detected it.

This is robust, cheap, and removes a whole class of cross-process detection
bugs. It is the one change to `src/launch/*` and must be added to the §5.1
checklist explicitly (the original "no changes to `src/launch/*`" framing is
relaxed to this one line).

### 5.11 What Option A does and does NOT give you (persistence, honestly)

To avoid overselling: Option A gives Orca-owned **visible panes**. That
means:
- ✅ A `mode: interactive` child opens in a real Orca pane (fixes the §1
  bug) rather than a headless background process.
- ✅ The pane **may persist visually** (orphaned) under Orca if the parent
  `pi` **crashes** rather than exits cleanly — because Orca owns the pane,
  not the parent process.
- ❌ It does **NOT** make parent-side result routing survive a parent
  restart. Result delivery still depends on the in-process sidecar watcher
  (`pollForExit`) and live parent state (`runningSubagents` map in
  `src/runtime/state.ts`). If the parent dies, in-flight results are lost
  exactly as they are today.
- ❌ Orca **handles** are runtime-scoped — they go stale after an Orca app
  restart, so a pane that survived visually is not addressable by its old
  handle afterward.

Surviving parent restart cleanly is the domain of the deferred Option B
(orchestration-transport bridge), not Option A. Do not claim restart-safe
coordination for Option A.

---

## 6. Testing plan

### 6.1 Unit tests (`test/mux/orca.test.ts`)

Fake the `orca` CLI via a stub spawn function (same pattern as
`test/mux/herdr.test.ts`). Cover:

- Detection: `isOrcaRuntimeAvailable` true when `orca` present + status
  running + inside worktree; false when status not running, when not in a
  worktree, when `orca` absent, when status JSON malformed.
- **Envelope-shape assertion (defensive against generic `orca` binary):**
  detection is false when `orca status` exits 0 but the JSON is not the
  expected `{result:{runtime:{running:true}}}` shape (simulates an unrelated
  CLI named `orca`).
- **Negative/mixed-env detection tests:**
  - `orca` on PATH but not inside Orca → false.
  - Orca active AND `TMUX` set → Orca wins (or tmux, per §5.2 order decision).
  - Orca active AND `CMUX_SOCKET_PATH` set → correct precedence.
  - Explicit `PI_SUBAGENT_MUX=tmux` inside Orca AND tmux genuinely available
    → tmux selected (override honored).
- `PI_SUBAGENT_MUX=orca` force + validation (requires §5.1 `muxPreference`
  edit).
- **Backend-result caching:** after first resolution, repeated
  `getMuxBackend()` calls do not re-spawn `orca status`; cache invalidates
  on session_shutdown.
- `createOrcaSurface`: parses `result.terminal.handle`, passes
  `--worktree active` + `--title`, throws on missing handle.
- **`createSurfaceSplit` explicit arm:** Orca split routes to Orca impl, not
  the Herdr fallback; throws on left/up; `fromSurface=undefined` behaves per
  §5.4 decision (prefer: throw).
- `sendCommand`: correct argv (`--terminal`, `--text`, `--enter`); **three
  cases** per §5.5 — normal command, empty command, command already ending
  in `\n`.
- `sendShellCommand`: uses staged temp script, sends `<path>; rm -f <path>`,
  cleans up on send failure.
- `readScreen` / `readScreenAsync`: joins `result.terminal.tail` array,
  tails to N lines. **Stale-vs-transient classification (both sync + async):**
  - stale (`terminal_handle_stale`/`terminal_not_found`) → **throws**.
  - transient (timeout, generic RPC error) → **returns `""`** (does NOT
    throw), so `pollForExit` keeps ticking.
- `closeSurface`: success path + swallows `terminal_handle_stale` /
  `terminal_not_found`.
- `renameCurrentTab` / `renameWorkspace`: correct argv; worktree rename
  gated by the opt-in env var; `renameCurrentTab` reads the handle from
  `PI_SUBAGENT_SURFACE`.
- **Child-side propagation:** interactive launch injects
  `PI_SUBAGENT_MUX=orca` into child env (unit-testable via the launch-parity
  suite, §6.2).
- Error envelope: `{error:{code,message}}` surfaces as `OrcaCommandError`
  with both fields; `isOrcaStaleHandle` classifies correctly.

### 6.2 Launch-parity tests (`test/launch/orca-interactive-launch.test.ts`)

Mirror `test/launch/herdr-interactive-launch.test.ts`. Verify the
interactive launch produces a `RunningSubagent` with `mode: "interactive"`,
a real Orca surface handle, the correct env vars (`PI_SUBAGENT_SURFACE`,
session vars), and that cwd/model/tools/skills resolution is identical to
the Herdr path. This guards against the abstraction leaking
backend-specific assumptions.

### 6.3 Live smoke (opt-in) — two layers, both required

**Layer 1 — mux adapter smoke** (`scripts/test-live-orca-mux.mjs`, mirrors
`scripts/test-live-herdr-mux.mjs`):
- Gated by `PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1` + a new
  `PI_SUBAGENT_ALLOW_LIVE_ORCA=1` (keep the opt-in pattern so CI never
  mutates a live Orca).
- Checks `orca status --json`, creates a marked terminal, sends a command,
  reads the screen, closes it, asserts lifecycle + cleanup.
- Registers as `npm run test:live-orca-mux`; prints `SKIP` without the opt-in
  (matches the Herdr guard contract documented in README §Testing).
- This validates the CLI adapter only — **it does not prove the §1 bug is
  fixed**.

**Layer 2 — pi-in-Orca acceptance repro** (`scripts/test-live-orca-pi.mjs`,
mirrors `scripts/test-live-herdr-pi.mjs`) — **this is the acceptance test**
for the §1 definition-of-done:
- Starts an interactive parent `pi` session inside an Orca-managed terminal.
- Parent launches a `mode: interactive` subagent.
- Assert the child lands in a **real, visible Orca pane** (verify via
  `orca terminal list --json` showing the child title), NOT a background
  process.
- This is the only check that exercises `launchOneSubagent`'s interactive
  branch end-to-end inside Orca. Do NOT defer it — the mux smoke cannot
  substitute (different layer).
- Per AGENTS.md live-behavior rules: run with a real model from the
  preferred matrix (e.g. a nahcrof GLM model or `openai-ws/gpt-5.5:low`),
  inspect both parent and child session JSONL, and verify the interactive
  branch held for the full parent response.

### 6.4 Validation gates (from AGENTS.md)

```bash
bunx tsc --noEmit
npm test
bunx biome check .      # structure/cleanup only
bunx knip               # must know about `orca` binary (package.json knip.ignoreBinaries)
```

Plus the file-size guard script from AGENTS.md: new files must stay under
600 LOC. `orca.ts` + `orca-surfaces.ts` together should be well under,
mirroring `herdr.ts` (~430 LOC) + `herdr-surfaces.ts` (~90 LOC).

---

## 7. Rollout / migration

- Pure addition; no existing backend behavior changes. Users not inside Orca
  see no difference (detection returns false, existing order unchanged except
  Orca slotted in).
- `PI_SUBAGENT_MUX=orca` gives users an explicit override if auto-detection
  ever misfires (e.g. Orca embedding tmux that sets `TMUX`).
- README gains a row in the mux-backends section and the env-var table.
- No agent-definition changes required; existing `mode: interactive` agents
  work unmodified.

---

## 8. Open questions to resolve before coding

**These are gating — resolve by live-probing an Orca pane before writing
production detection/send code.** The unit tests (§6.1) can be written first
against the decided contract.

1. **Detection env var (subsumes the former tmux-precedence question).**
   Does the Orca app export any env var into the shell of terminals it
   creates (e.g. `ORCA_WORKTREE_ID`, `ORCA_TERMINAL_HANDLE`,
   `ORCA_SESSION_ID`)? This single answer drives the §5.2 decision tree:
   - If **yes**: cheap env-gated detection + (if `TMUX` also set) it wins the
     embedded-tmux race on its own — the tmux-precedence question dissolves.
     Detection order becomes less sensitive.
   - If **no**: subprocess-based detection + the §5.2 session-scoped cache is
     mandatory, and `TMUX` precedence must be handled by ordering Orca
     before tmux.
   **Action:** `env | grep -i orca` AND `echo $TMUX` inside a live Orca
   terminal. One probe answers both. (The `orca-cli` skill notes handles are
   runtime-scoped and `--terminal` defaults to active — suggests an env var
   exists but does not name it.)
2. **`--enter` vs trailing newline.** The skill always pairs
   `terminal send --text <x> --enter`. Confirm whether `--enter` alone (with
   empty `--text`) sends a bare Enter, matching how `sendCommand(surface, "")`
   is used for re-prompting in some backends. If not, special-case empty
   commands. Cover the three §5.5 cases.
3. **Staged-shell confirmation.** Confirm `orca terminal create` yields an
   interactive shell such that `<scriptPath>; rm -f <scriptPath>` and the
   `cd <cwd> &&` prefix behave like Herdr's (§3.3). The whole quoting
   strategy rests on this.
4. **Worktree selector at create time.** `--worktree active` relies on Orca
   resolving the parent's worktree from cwd. Confirm this works when the
   parent pi was launched with a `cwd:` frontmatter override that differs
   from the Orca worktree root. If not, resolve the explicit worktree id via
   `orca worktree current --json` and pass `--worktree id:<id>`.
5. **Pane persistence vs `parent-close-policy: terminate`.** Per §5.11, Orca
   panes may orphan if the parent pi **crashes**. Decide: desired (matches
   Orca's model) vs register Orca-side cleanup. Default: desired +
   documented. (Note: result routing still does not survive — see §5.11.)

---

## 9. Out-of-scope follow-up (Option B sketch — for later decision)

If, after shipping A, parent-restart result loss or richer child→parent
messaging becomes real:

- When Orca backend is active, the child protocol helper
  (`src/tools/subagent-done.ts`) additionally emits
  `orca orchestration send --to <coordinator> --type heartbeat|worker_done`
  with `taskId`/`dispatchId`/payload.
- The parent's result router (`src/runtime/result-router.ts`) gains an
  optional Orca-transport path: instead of (or alongside) the in-process
  sidecar watcher, use `orca orchestration check --wait` for completion.
- Introduce `ask` (blocking question up) and `reply` (answer down) as new
  child tools, mapped to `orca orchestration ask/reply`.
- **Skip** task/dispatch/gate DAG unless a concrete multi-wave dependency
  need appears — the flat `launch → wait → result` + parallel `children`
  model already covers most real work.

This is intentionally not designed in detail here; it's a placeholder so the
deferred decision is recorded.

---

## 10. Checklist

**Resolve first (live probe an Orca pane):**
- [ ] §8 Q1: `env | grep -i orca` + `echo $TMUX` → pick §5.2 decision branch
- [ ] §8 Q2: `--enter` semantics for empty/trailing-newline commands
- [ ] §8 Q3: staged-shell behavior confirmation (interactive shell?)
- [ ] §8 Q4: `--worktree active` under `cwd:` override

**Implementation:**
- [ ] `src/mux/orca.ts` — Orca CLI client (spawn + timeout, envelope parse,
      stale/transient classifier `isOrcaStaleHandle`)
- [ ] `src/mux/orca-surfaces.ts` — surface contract impl
- [ ] `src/mux/core.ts` — **three** edits: union, `muxPreference()`, detection
      + session-scoped cache of `getMuxBackend()` result + `muxSetupHint()`
- [ ] `src/mux/surfaces.ts` — create/split/rename routing (**explicit Orca
      arm in `createSurfaceSplit`**; define `fromSurface=undefined`)
- [ ] `src/mux/io.ts` — send/read/close arms + staged-shell + transient-vs-
      stale in `readScreen`/`readScreenAsync` (return `""` on transient)
- [ ] `src/launch/interactive.ts` — **one line**: inject `PI_SUBAGENT_MUX=orca`
      into child env (§5.10)
- [ ] `test/mux/orca.test.ts` — incl. negative/mixed-env, envelope-shape,
      caching, sendCommand 3-case, read stale-vs-transient (sync+async),
      split fromSurface=undefined
- [ ] `test/launch/orca-interactive-launch.test.ts` — incl. child env
      `PI_SUBAGENT_MUX=orca` assertion
- [ ] Register suites in `test/test.ts`
- [ ] `scripts/test-live-orca-mux.mjs` (layer 1) +
      `scripts/test-live-orca-pi.mjs` (layer 2, acceptance) +
      `package.json` scripts + knip entry `orca`

**Verify:**
- [ ] README + AGENTS.md docs (incl. §5.11 honest persistence language)
- [ ] Gates: `tsc --noEmit`, `npm test`, `biome check`, `knip`, size guard
- [ ] **Acceptance:** layer-2 pi-in-Orca repro opens a visible pane, not a
      background child (§1 definition-of-done)
- [ ] Restore any temp agent/session/test env after live runs (AGENTS.md)
