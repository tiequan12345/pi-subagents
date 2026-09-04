# Provider-error recovery port — v2.6.6 → v2.6.9 onto `custom/orca`

Ports four upstream commits onto our branch:

| SHA | Tag | Subject |
|-----|-----|---------|
| `c57cf7a` | v2.6.6 | don't discard a subagent's result after a recovered provider error |
| `048efd0` | v2.6.6 | track subagent result provenance |
| `155e64c` | v2.6.8 | recover subagents stopped at tool boundaries |
| `655a684` | v2.6.9 | recover unfamiliar provider failures safely |

## Invariants the four commits establish

Verify the merge against these three statements; every edit below serves one of them.

1. **Exactly one sidecar verdict per child.** An `error` verdict may be superseded by a later `done` or `ping`; nothing may supersede `done`, `ping`, or our `compacted`.
2. **A `summary` is surfaced as salvaged work only when `summarySource !== "runtime"`.** Watcher fallbacks and synthesized exit strings must never be presented as child output.
3. **Provider errors recover by default.** Only the permanent patterns (quota, billing, auth, missing model, validation, safety) opt out.

## Approach: single squashed port, upstream order

One squashed semantic port, not four replayed commits.

- Our branch already implements part of `c57cf7a` (the `pendingProviderError` + `session_shutdown` defer path at `src/tools/subagent-done.ts:232,368`). A commit-by-commit replay would build intermediate states that fight our existing code.
- The four commits are tightly coupled around one path: error classify → defer → salvage → provenance → surface.
- Each change below cites its source SHA so git archaeology still works.

Skip one dead edit: `c57cf7a` adds a phrase to `RETRYABLE_PROVIDER_ERROR_PATTERN` in `src/auto-exit.ts`, but `655a684` deletes that whole pattern. Take `655a684`'s classifier and skip the `c57cf7a` one-liner.

## Reconciliation summary

| File | Our custom state | Upstream change | Action |
|------|------------------|-----------------|--------|
| `src/auto-exit.ts` | clean | `655a684` replaces classifier | take verbatim |
| `src/runtime/state.ts` | clean | `048efd0` rewrites `hasRealSubagentOutput` | take verbatim |
| `src/runtime/result-router.ts` | clean | `c57cf7a` + `048efd0` salvaged-output body | take verbatim |
| `src/runtime/wait-result.ts` | clean | `c57cf7a` + `048efd0` salvaged-output body | take verbatim |
| `src/session/session.ts` | clean | `048efd0` + `155e64c` provenance + tool-use boundary | take verbatim |
| `src/types.ts` | adds `exitSignal?: SubagentExitSignal` | `048efd0` adds `summarySource?: SubagentSummarySource` | merge — both fields |
| `src/session/exit-sidecar.ts` | atomic `writeSubagentExitSignal` + `SubagentExitSignal` union incl. `"compacted"` | `c57cf7a`+`048efd0` add `writeSubagentExitSidecar(..., { supersede })` | extend our atomic writer with a `supersede` option — see schema below |
| `src/tools/subagent-done.ts` | threshold compaction; done deferred in background; `session_shutdown` reporter | `c57cf7a` removes eager permanent-error write + adds supersede on done/ping; `155e64c` adds tool-boundary recovery | merge — three edits below |
| `src/tools/provider-error-recovery.ts` | `writeExitSignal(payload: SubagentExitSignal)` type tighten | untouched by these 4 | none |
| `src/runtime/background-watch.ts` | removed terminal-grace reaper; adds `exitSignal` to result | `048efd0` adds `summarySource` via `findLastSubagentOutputWithSource` | merge onto our slimmed body |
| `src/runtime/interactive-watch.ts` | `selectInteractiveCompletion` helper; adds `exitSignal` | `048efd0` rewrites `getSummary` to return `{ summary, summarySource }` | merge — keep our completion selection, apply their `getSummary` |
| `src/runtime/background-retry.ts` | imports `isRetryableProviderErrorMessage` at `:1,:56` | `655a684` renames it | rename import + call site |

## Step-by-step

### Step 1 — Classifier (`655a684`)

Files: `src/auto-exit.ts`, `src/runtime/background-retry.ts`.

1. Replace `src/auto-exit.ts` lines ~9–22 with upstream's `PERMANENT_PROVIDER_ERROR_PATTERNS`, `normalizeProviderErrorMessage`, and `shouldRecoverProviderErrorMessage`. Update the doc comment on `findLatestAssistantError` per the diff. Change the `recoveryKind` line (`:62`) from `isRetryableProviderErrorMessage(raw)` to `shouldRecoverProviderErrorMessage(raw)`.
2. `src/runtime/background-retry.ts:1` — rename import to `shouldRecoverProviderErrorMessage`. `:56` — rename the call. Keep the function name `isRetryableBackgroundResult` (it is our public surface); only the classifier it wraps changes.
3. Tests: replace `test/auto-exit.test.ts` `describe("isRetryableProviderErrorMessage")` block with upstream's `describe("shouldRecoverProviderErrorMessage")` block. Add the `655a684` unfamiliar-HTTP-400 regression to `test/tools/subagent-done-recovery.test.ts` (asserts the new classifier nudges). `test/test.ts` already imports `auto-exit.test.ts`, `session/session.test.ts`, `session/exit-sidecar.test.ts`, and `tools/subagent-done-recovery.test.ts` — no registration changes.

**Risk:** Low. One renamed import outside upstream's diff (`background-retry.ts`). The semantic flip (default-recover) is intentional and matches what our parent-side retry already assumes.

**Validate:** `bunx tsc --noEmit` then `npm test -- --test-name-pattern="shouldRecoverProviderErrorMessage"`.

### Step 2 — Supersede + defer permanent errors to shutdown (`c57cf7a`, minus the auto-exit one-liner)

Files: `src/session/exit-sidecar.ts`, `src/tools/subagent-done.ts`, `src/runtime/state.ts`, `src/runtime/result-router.ts`, `src/runtime/wait-result.ts`.

1. **`src/session/exit-sidecar.ts`** — extend our atomic writer with a `opts?: { supersede?: boolean }` third parameter. Keep the existing temp-file + `linkSync` create branch untouched. For the supersede branch, **do not** `writeFileSync` over the live path — truncate-then-write lets the parent poll read a partial file (the race we already flag as a rollback trigger). Instead: validate first, then publish atomically.
   - Read and `JSON.parse` the existing file; run it through `decodeSubagentExitSignal`. If the decoded `type` is `done`, `ping`, or `compacted` → return `false`. If decode throws or returns the malformed-error sentinel → allow. If decoded `type === "error"` → allow.
   - Write the new payload to the same temp-file shape (`${exitFile}.${pid}.${uuid}.tmp`, `flag: "wx"`).
   - `renameSync(tempFile, exitFile)` — atomic replace on the same filesystem. Clean up the temp in `finally` as today.
   - Return contract: `true` on create or supersede-overwrite, `false` on refusal. Upstream's writer returns `void`; we keep our boolean so existing callers' success checks still work.
   This absorbs both `c57cf7a` (supersede-error-only) and `048efd0` (supersede-unreadable) through the typed decoder we already have, so we keep one typed model instead of upstream's untyped `writeSubagentExitSidecar`.
2. **`src/tools/subagent-done.ts`** — `writeExitSignal` gains `opts?: { supersede?: boolean }` and forwards it. **Four** call-site edits (cite by symbol, not line — this file drifts):
   - `recoveryKind === "none"` branch inside `agent_end` (the block that calls `writeExitSignal({ type: "error", errorMessage, stopReason, outputTokens })` followed by `requestShutdown`): **delete** the `writeExitSignal` call. Keep `providerErrorRecovery.cancelPendingRecovery()`, `cancelPendingPiRecovery()`, and `requestShutdown(ctx)`. `pendingProviderError` is assigned earlier in the same handler, so `session_shutdown` writes the error sidecar. This is the core `c57cf7a` fix and the one real behavior change on our side.
   - Interactive clean-done write at the end of `agent_end` (`writeExitSignal({ type: "done", outputTokens })`): add `{ supersede: true }`.
   - `caller_ping` tool `execute` write (`writeExitSignal({ type: "ping", ... })`): add `{ supersede: true }`.
   - `subagent_done` tool `execute` write (`writeExitSignal({ type: "done", outputTokens })`): add `{ supersede: true }`. This is the primary explicit-success path and the one that most needs to supersede a stale error sidecar.
   - First-write-wins stays for the threshold-compaction done path (`writeExitSignal(compactionSignal ?? ...)`) and the `session_shutdown` error report — both publish canonical terminal verdicts that nothing should overwrite.
   - Why the other eager error writes are **not** deferred: `provider-error-recovery.ts` `handleRecoveryExhausted` writes `type: "error"` only after the full bounded retry window has fired (no later success is possible), and `failPendingPiRecovery` writes only after the Pi-native recovery timer expires. Both stay eager — correct as-is.
3. **`src/runtime/state.ts`** — export `hasRealSubagentOutput` (signature change comes in Step 3).
4. **`src/runtime/result-router.ts` + `src/runtime/wait-result.ts`** — take `c57cf7a`'s salvaged-output body verbatim. After Step 3, `hasRealSubagentOutput(completed.summary)` becomes `hasRealSubagentOutput(completed)` per `048efd0`.
5. Ping text: add `\n\nMessage from the subagent:\n${result.ping?.message ?? ""}` in `wait-result.ts` `getSubagentWaitPingResult` per `c57cf7a`.
6. Tests: `test/session/exit-sidecar.test.ts` supersede cases translated to our typed API — supersede-over-error allowed, supersede-over-done/ping/compacted refused (including our unique `compacted`, which upstream cannot cover), default first-write-wins, unreadable-sidecar-replaced. Add the `c57cf7a` salvaged-output cases to `result-router.test.ts` and `wait.test.ts`. Add the `c57cf7a` permanent-error-on-shutdown case to `subagent-done-recovery.test.ts` (it fires `agent_end` then `session_shutdown`).

**Risk:** Medium. The exit-sidecar writer is the highest-stakes file (atomic publish, races with parent poll). The `renameSync` supersede path must be tested against an existing `error` file, an existing `done`/`ping`/`compacted` file (refusal), and a malformed file. Add a `compacted` refusal case — upstream has no such signal type so their suite cannot cover it; it is our unique regression surface.

**Validate:** `bunx tsc --noEmit`; `npm test`. Live repro (AGENTS.md "pi-subagents live behavior validation"): `.pi/agents/bg-mode.md` under `zai-messages/glm-5-turbo:high` — force a transient provider error mid-run and confirm (a) the parent retries via `background-retry.ts`, (b) a recovered child still delivers its real summary, not "did not produce a result".

### Step 3 — Provenance (`048efd0`)

Files: `src/types.ts`, `src/session/session.ts`, `src/runtime/state.ts`, `src/runtime/background-watch.ts`, `src/runtime/interactive-watch.ts`, `src/runtime/result-router.ts`, `src/runtime/wait-result.ts`.

1. **`src/types.ts`** — add `export type SubagentSummarySource = "subagent" | "runtime";` and `summarySource?: SubagentSummarySource` on `SubagentResult`. Keep our `exitSignal?: SubagentExitSignal`.
2. **`src/session/session.ts`** — add `SubagentOutput` interface, `findLastAssistantOutput` (private), `findLastSubagentOutputWithSource` (exported), keep `findLastSubagentOutput` as a thin wrapper. Take `048efd0` verbatim.
3. **`src/runtime/state.ts`** — change `hasRealSubagentOutput` signature to `(result: Pick<SubagentResult, "summary" | "summarySource">): boolean` and body to `result.summarySource !== "runtime" && result.summary.trim() !== ""`. Update `getSubagentCompletionStatus` call site.
4. **`src/runtime/background-watch.ts`** — merge onto our slimmed body. Keep our deletions (no terminal-grace reaper, no `terminateBackgroundChildProcess`) and our `exitSignal: typedExitSignal` addition. This is a fail-open change (`048efd0` drops the old "Sub-agent exited…" string heuristic and trusts `summarySource` alone), so **every** synthesized fallback string must be tagged `"runtime"` or it will be presented to the model as salvaged work. Track `let summarySource: SubagentSummarySource = "runtime"` and reassign alongside each `summary =` in `watchBackgroundSubagent`. Enumerate by symbol:
   - Default initial `summary` (`Background agent exited with code ${exitCode}`) — runtime.
   - `findLastSubagentOutputWithSource` hit — use the source it returns (subagent).
   - `exitCode !== 0 && stderr` fallback (`…exited with code…\n\n${stderr}`) — runtime.
   - `exitCode !== 0` no-stderr fallback (`Background agent exited with code ${exitCode}`) — runtime.
   - `stdout || "Background agent exited without output"` — the `stdout` branch is subagent; the `"without output"` literal is runtime.
   - Top-level `else if (stdout)` — subagent.
   - Top-level `else if (exitCode !== 0 && stderr)` — runtime.
   - `onError` summary (`Background agent failed to start: ${error.message}`) — runtime.
   Include `summarySource` in both `finish(...)` calls. None of these background strings were caught by the old heuristic (it matched only the interactive `"Sub-agent …"` prefixes), so this is a real correctness gain — but only if all sites are tagged.
5. **`src/runtime/interactive-watch.ts`** — keep `selectInteractiveCompletion` and the `completion` selection. Change `getSummary` to return `{ summary, summarySource }` using `findLastSubagentOutputWithSource`. Same fail-open discipline: the `findLastSubagentOutputWithSource` hit is subagent; both arms of the `completion.exitCode !== 0 ? "Sub-agent exited with code …" : "Sub-agent exited without output"` fallback are runtime; the outer `else` with the same ternary is runtime. Thread `summarySource` into the success, cancelled (`"Subagent cancelled."` is runtime), and error (`Subagent error: …` is runtime) result branches.
6. **`src/runtime/result-router.ts` + `src/runtime/wait-result.ts`** — flip `hasRealSubagentOutput(completed.summary)` → `hasRealSubagentOutput(completed)`.
7. **`test/support/project.ts`** — add `findLastSubagentOutputWithSource` to the existing re-export block alongside `findLastSubagentOutput` and `findLastAssistantMessage`.
8. Tests: add `summarySource: "subagent"` to existing fixtures in `result-router.test.ts`, `state.test.ts`, `wait.test.ts`. Add the `048efd0` provenance cases (including the `session.test.ts` "synthesized terminal errors are runtime" case).

**Risk:** Medium. `background-watch.ts` and `interactive-watch.ts` are pre-modified by us; the merge is mechanical but touches the hot result path. Re-run the Step 2 live repro afterward.

**Validate:** `bunx tsc --noEmit`; `npm test`; repeat the Step 2 live repro and confirm a runtime-fallback summary (kill child before output) is **not** presented as salvaged work.

### Step 4 — Tool-boundary recovery (`155e64c`)

Files: `src/session/session.ts`, `src/tools/subagent-done.ts`.

1. **`src/session/session.ts`** — add `getStopReason`, `isToolUseStopReason`, and the early `return null` in `findLastAssistantOutput` when the last assistant message is a textless tool-use boundary. Take `155e64c` verbatim (it builds on Step 3's `findLastSubagentOutputWithSource`).
2. **Widen the typed sidecar for `stopReason: "toolUse"`.** `155e64c` writes `stopReason: "toolUse"` on boundary exhaustion. Our types reject this today and the decoder silently rewrites it — three coordinated edits:
   - `src/session/exit-sidecar.ts`: widen the error variant to `stopReason: "error" | "toolUse"`. In `decodeSubagentExitSignal`, preserve the incoming `stopReason` when it is `"toolUse"` (default to `"error"` only when missing/malformed) instead of hardcoding `"error"`.
   - `src/auto-exit.ts`: widen `SubagentErrorInfo.stopReason` to `"error" | "toolUse"`.
   - Decide whether `getSubagentTerminalStopReason` (`src/session/session.ts`) should distinguish `toolUse` from `error` in its stop-reason scan; if not, leave it — the typed signal still reaches the parent verbatim.
3. **`src/tools/subagent-done.ts`** — in the `autoExit` block, add `turn_start` and `tool_execution_end` handlers alongside `agent_start`. Add the module-level `endedAtToolUseBoundary`, `MAX_CONSECUTIVE_TOOL_BOUNDARY_ENDS = 3`, `TOOL_BOUNDARY_RECOVERY_NUDGE = "continue"`. At the top of `agent_end` (before the `errorInfo` block), add the boundary check: nudge "continue" up to twice, on the third consecutive boundary write `type: "error"` with `stopReason: "toolUse"` and shut down. Reset `consecutiveToolBoundaryEnds = 0` on a clean done. Preserve the `intentionallyTerminatedToolBatch` carve-out so a tool that returns `{ terminate: true }` is honored. The nudge uses `deliverAs: "steer"`; that surfaces in our `shouldMarkUserTookOver` path, but `isOperatorInput` rejects extension-sourced input first, so it cannot read as operator takeover.
4. Tests: add the four `155e64c` cases to `test/tools/subagent-done-recovery.test.ts` (nudge, intentional termination, exhaustion, alternation with provider errors) and the one `session.test.ts` case.

**Risk:** Medium. The `stopReason: "toolUse"` widening is the real Step 4 risk — get the union, the decoder, and `SubagentErrorInfo` in lockstep or the parent sees a generic `error`. `turn_start` and `tool_execution_end` are both emitted by our pinned `@earendil-works/pi-coding-agent@0.79.10` (confirmed in `dist/core/agent-session.js` and the extension types — 15 and 12 occurrences respectively); no Pi bump or `1743663` pull is needed. Our peer range is `>=0.79.0`; if a user is on an older `0.79.x` lacking these events the handlers simply never fire (degraded but safe), so tighten the floor only if we want the boundary recovery guaranteed.

**Validate:** `bunx tsc --noEmit`; `npm test`. Live repro: `.pi/agents/bg-mode.md` under `openai-ws/gpt-5.4-mini:medium` — engineer a task that ends on a tool call without a follow-up turn and confirm the child self-continues rather than exiting.

## Single error-classification path (decision)

One classifier survives: `shouldRecoverProviderErrorMessage` in `src/auto-exit.ts` (default-recover, permanent patterns exclude). It is the single source of truth for:

- Child-side `findLatestAssistantError` → `recoveryKind` (`auto-exit.ts`).
- Parent-side `isRetryableBackgroundResult` (`background-retry.ts:56`).

Do not keep a parallel classifier in `background-retry.ts` or `provider-error-recovery.ts`. Our `provider-error-recovery.ts` only consumes `SubagentErrorInfo` and does not classify; leave it.

## Tool-boundary hook (decision)

`endedAtToolUseBoundary` lives in `subagent-done.ts` and runs in the `autoExit` `agent_end` handler only. It fires before the provider-error branch. The orca mux path does not stop at tool boundaries (it observes process exit), so no orca-side change is needed. If a tool-boundary nudge gives way to a provider error on the next turn, the provider-error branch handles it and `consecutiveToolBoundaryEnds` resets on the next clean done.

## Rollback / abort criteria

Abort and regroup if:

- `session_shutdown` does not fire reliably in `pi -p` background mode (our done-deferral and the new error-deferral both depend on it). Symptom: background children hang instead of reporting failure.
- The atomic `writeSubagentExitSignal` supersede path loses a race against the parent's `consumeSubagentExitSignal` poll. Symptom: parent reads a half-written file or an `EEXIST` throws out.
- The `stopReason: "toolUse"` value round-trips through `decodeSubagentExitSignal` as `"error"` (union or decoder not updated in lockstep). Symptom: parent cannot distinguish tool-boundary exhaustion from a provider error in the result.
- A test fails for a reason unrelated to the port after Step 1 (indicates a hidden dependency on a later v2.7.x runtime change — stop and cherry-pick the minimum prerequisite).

## Out of scope (later themes)

- Parent-owned timeout / idle-timeout (v2.7.1).
- Context reminders + resume guard (v2.7.0, v2.7.1).
- Nested-spawning controls (v2.7.0, v2.7.1).
- Auto-exit takeover / `/auto-exit` re-arm (v2.7.0).
- Zellij / Herdr placement policies (v2.6.0, v2.6.4).
- Extension-package + skill-discovery parity (v2.5.4, v2.6.0).
- Dynamic Pi thinking-level validation (v2.6.2), APPEND_SYSTEM inheritance (v2.6.5).
