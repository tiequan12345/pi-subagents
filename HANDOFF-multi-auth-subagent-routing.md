# Handoff: route Pi subagents through `pi-multi-auth`

## Status snapshot

- **Bug confirmed:** OpenAI Codex subagents bypassed `pi-multi-auth` and used the canonical first Codex account.
- **Milestone one implemented** in `pi-subagents`: broker-aware self-managed injection on initial launch + resume/retry.
- **Review fixes landed:** `extensions: all` keeps defaults and still adds required broker `-e` paths; resume no longer collapses defaults to `--no-extensions`; malformed broker modes fail closed; persist non-secret `delegatedAuth` marker and require re-prepare on resume; strip spoofed `PI_DELEGATED_AUTH_*`; background resume prepares auth once.
- **Validation:** `bunx tsc --noEmit` + `npm test` pass (528); live `pi -p` auth-probe child persisted multi-auth path and completed on `openai-codex/gpt-5.6-luna` while `manualActiveCredentialId=openai-codex-1`.
- **Still deferred:** lease mode, lifecycle `release`/`reportAttemptResult`, full usage-meter confirmation across accounts.
- **Pi:** `0.80.10`
- **`pi-subagents`:** `2.5.3`, branch `custom/orca`
- **`pi-multi-auth`:** branch `oauth-0.80.8-migration`
- Both repos are local Pi packages:
  - `/Users/timhsia/Sync/Dev/pi-subagents`
  - `/Users/timhsia/Sync/Dev/pi-multi-auth`

## User-visible problem

The parent Pi session honors the account selected in `/multi-auth`, but OpenAI subagents (`luna-agent`, `gpt-agent`, `planner-agent`, and `review-agent`) increase usage on the primary Codex account.

The user's observation is correct. The parent and child use different auth paths.

## Confirmed root cause

### Parent Pi path

1. The normal parent process loads `pi-multi-auth` from `~/.pi/agent/settings.json`.
2. `pi-multi-auth/src/account-manager.ts:switchActiveCredential()` persists the selected account as `manualActiveCredentialId`.
3. `AccountManager.acquireCredential()` checks that ID before automatic rotation.
4. `pi-multi-auth/src/provider.ts` passes the selected account's secret to the provider request.

Therefore, normal parent requests use the account selected in `/multi-auth`.

### Child Pi path

1. `pi-subagents/src/tools/subagent-tools.ts:launchOneSubagent()` copies the parent model and thinking level, but not its account selection.
2. `pi-subagents` starts a new Pi process in:
   - `src/launch/background.ts:launchBackgroundSubagent()`
   - `src/launch/interactive.ts:launchInteractiveSubagent()`
3. The OpenAI agent definitions contain an explicit extension allowlist:

   ```yaml
   extensions: npm:pi-mcp-adapter
   ```

   Affected definitions (user global agents, not this repo):

   - `~/.pi/agent/agents/luna-agent.md`
   - `~/.pi/agent/agents/gpt-agent.md`
   - `~/.pi/agent/agents/planner-agent.md`
   - `~/.pi/agent/agents/review-agent.md`

   Repo `.pi/agents/` only has smoke agents and is not the bug surface.

4. `src/launch/policy.ts:resolveSubagentExtensions()` returns that explicit list.
5. `src/launch/prep.ts:getExtensionLaunchArgs()` adds `--no-extensions` whenever the list is explicit, then adds only the mandatory child extension and listed extensions:

   ```text
   --no-extensions -e subagent-done.ts -e npm:pi-mcp-adapter
   ```

6. The child therefore does **not** load `pi-multi-auth`.
7. `src/launch/child-command.ts:getSubagentChildProcessEnv()` copies process environment plus Pi bookkeeping, but no account ID or delegated credential.
8. Pi's built-in auth resolver reads the exact `openai-codex` entry from the shared `auth.json`.
9. `pi-multi-auth/src/auth-writer.ts` stores accounts as:
   - `openai-codex` — canonical first/primary account
   - `openai-codex-1`, `openai-codex-2`, ... — backup accounts
10. Built-in Pi does not know about the backup naming scheme or `manualActiveCredentialId`, so the child uses `auth.json["openai-codex"]`.

## Existing but unused cross-extension contract

`pi-multi-auth` already contains most of an intended subagent integration:

### Broker registry

`pi-multi-auth/src/delegated-auth-broker.ts`

- Registers `pi-multi-auth` on:

  ```typescript
  globalThis.__piDelegatedAuthBrokerRegistry
  ```

- Exposes:
  - `prepareSubagentAuth()`
  - `release()`
  - `reportAttemptResult()`
- Current `prepareSubagentAuth()` returns `mode: "self-managed"` with:
  - `extensionDirs: [EXTENSION_ROOT]` (absolute package root)
  - `env: { PI_DELEGATED_AUTH_RUNTIME_DIR: getAgentRuntimeRoot() }`

The registry works because both extensions run in the parent Pi process. It cannot cross into the child process by itself; `pi-subagents` must read it before spawning the child.

### Milestone-1 child requirements (self-managed)

Self-managed mode needs **only**:

1. The child process loads `pi-multi-auth` (via injected `-e <EXTENSION_ROOT>`).
2. The child gets `PI_DELEGATED_AUTH_RUNTIME_DIR` so it reads the same runtime root / `multi-auth.json` as the parent.

`pi-multi-auth` resolves runtime state in this order (`runtime-paths.ts`):

```text
PI_DELEGATED_AUTH_RUNTIME_DIR
→ PI_MULTI_AUTH_RUNTIME_DIR (legacy)
→ PI_CODING_AGENT_DIR
→ ~/.pi/agent
```

Children often set `PI_CODING_AGENT_DIR` for local agent config. Without `PI_DELEGATED_AUTH_RUNTIME_DIR`, a child can load multi-auth but read the wrong `multi-auth.json` and miss `manualActiveCredentialId`.

### Lease-mode runtime contract (deferred)

`pi-multi-auth/src/runtime-context.ts` also recognizes lease variables:

```text
PI_AGENT_ROUTER_SUBAGENT=1
PI_DELEGATED_AUTH_PROVIDER_ID
PI_DELEGATED_AUTH_LEASE_ID
PI_DELEGATED_AUTH_API_KEY
```

When all required values exist, `provider.ts` pins requests to the delegated credential.

**Do not set these in milestone one.** They are lease-mode only. Self-managed account selection works through normal `AccountManager.acquireCredential()` once the extension loads against the correct runtime root.

### Credential leasing

`pi-multi-auth/src/balancer/key-distributor.ts`

Existing methods include:

- `acquireForSubagent()`
- `releaseFromSubagent()`
- `getLeaseForSession()`
- `shouldBypassDelegatedSubagentAcquisition()`
- `getDelegatedCredentialRoutingCapabilities()`

However, the broker currently returns `self-managed`, not a real lease.

### Missing link

`pi-subagents` has no reference to:

- `__piDelegatedAuthBrokerRegistry`
- `prepareSubagentAuth()`
- any `PI_DELEGATED_AUTH_*` variable
- `PI_AGENT_ROUTER_SUBAGENT`

That is the gap to implement.

## Recommended first implementation

Implement **broker-aware self-managed auth injection** in `pi-subagents`. Do not start with credential leases.

This first step solves the reported problem without passing secrets between processes:

1. Discover the delegated-auth broker in the parent process.
2. Ask it to prepare auth for the child's provider/model.
3. If it returns `self-managed`:
   - append its absolute `extensionDirs` to the child's explicit extension allowlist on `prepared.effectiveExtensions`;
   - merge its environment overlay after user frontmatter so broker-owned values win;
   - launch the child normally.
4. The child loads `pi-multi-auth`, reads the shared auth and rotation state via `PI_DELEGATED_AUTH_RUNTIME_DIR`, and honors `manualActiveCredentialId`.

### Why this is the right first step

- Fixes the current primary-account usage bug.
- Uses the contract already present in `pi-multi-auth`.
- Avoids hard-coding the local `pi-multi-auth` path in `pi-subagents`.
- Avoids putting an OAuth access token in a shell command or persisted session metadata.
- Keeps existing `round-robin`, `usage-based`, and `balancer` selection inside `pi-multi-auth`.
- Requires no change to Pi core or `auth.json` layout.

## Suggested code shape

Keep this small. One shared helper is enough:

```text
src/launch/delegated-auth.ts
```

Callers: `launch-coordinator.ts` (initial launch) and the resume plan builders (below). Do not put broker logic in `background.ts` / `interactive.ts`.

Define structural types locally; do not add a package dependency from `pi-subagents` to `pi-multi-auth`.

The helper should:

1. Read `globalThis.__piDelegatedAuthBrokerRegistry` defensively.
2. List brokers with the `delegated-auth` capability.
3. Build a request from the prepared launch:
   - `providerId`: provider segment of `prepared.effectiveModel`
   - `modelId`: model segment of `prepared.effectiveModel`
   - `modelRef`: `prepared.effectiveModelRef`
   - `parentSessionId`: `ctx.sessionManager.getSessionId()` when available
   - `subagentSessionId`: child session file path (stable unique value)
   - `api`: optional; leave undefined if unavailable
4. Call brokers in registration order and use the first result whose mode is not `none`.
5. Validate returned data:
   - `extensionDirs` entries must be non-empty **absolute** paths (reject relative paths; child cwd differs from parent).
   - env keys/values must be non-empty strings.
6. Return a launch overlay; never log environment values.

Expected result shape for milestone one:

```typescript
type DelegatedAuthLaunchOverlay = {
  brokerId: string;
  mode: "self-managed";
  extensionDirs: string[];
  env: Record<string, string>;
};
```

Mode handling:

- `mode: "none"` or no registry → current behavior (no overlay).
- `mode: "self-managed"` → apply extension + env overlay.
- `mode: "lease"` → **hard fail** with a clear unsupported error. Do not silently fall back; silent fallback looks fixed while still billing the primary account.

## Initial launch integration

Primary integration point:

```text
src/launch/launch-coordinator.ts:coordinateSubagentLaunch()
```

### Critical ordering

Current coordinator order:

1. `prepareSubagentLaunch`
2. `seedPreparedSubagentSession` → `writeExtensionEntry(prepared.effectiveExtensions)`
3. `buildPersistedSubagentLaunchMetadata(prepared)`
4. `getBaseSubagentEnvVars(prepared)`
5. set `PI_SUBAGENT_SESSION` / auto-exit

Background and interactive launch then build CLI args from **`prepared.effectiveExtensions`** via `getPreparedExtensionLaunchArgs(prepared)`. They do not read a side-channel extensions list from the coordinated result.

So the overlay must mutate `prepared` itself, and it must run **before seed**.

### Required order

1. `const prepared = await prepareSubagentLaunch(...)` — provider/model/session data exists.
2. Resolve the delegated-auth overlay from `prepared` + `ctx`.
3. Extension merge on **`prepared.effectiveExtensions`** (mutate in place; single source of truth):
   - If `prepared.effectiveExtensions === undefined`, all normal extensions already load; keep it undefined. Do not switch to an explicit list / `--no-extensions`.
   - If it is an explicit list, append absolute `extensionDirs` and dedupe (string equality is enough for milestone one).
4. **Then** seed (`writeExtensionEntry` sees the injected path).
5. Build persisted launch metadata from the mutated `prepared` (resume keeps the injected extension).
6. Build base env with `getBaseSubagentEnvVars(prepared, ...)`.
7. Apply coordinator-owned env (`PI_SUBAGENT_SESSION`, auto-exit, etc.).
8. Merge broker env **last**:

   ```typescript
   Object.assign(envVars, delegatedAuth.env);
   ```

   Broker values must win over agent frontmatter. Frontmatter must not spoof `PI_DELEGATED_AUTH_*`.

Both initial launch paths already consume the coordinated result:

- `src/launch/background.ts`
- `src/launch/interactive.ts`

Do not duplicate broker logic in those two files. Do not add a parallel extensions field on `CoordinatedSubagentLaunch`; mutate `prepared.effectiveExtensions` so CLI args, seed entry, metadata, and `PI_SUBAGENT_EXTENSIONS` stay aligned.

## Resume and retry behavior

Do not claim the integration complete until resume works.

Relevant paths (these do **not** go through `coordinateSubagentLaunch`):

- `src/launch/background-resume.ts` — `buildBackgroundResumePlan()`, `respawnBackgroundChild()`
- `src/runtime/resume-service.ts` — `resumeSubagentSession()` (background + interactive branches)
- `src/runtime/background-retry.ts` — uses `buildBackgroundResumePlan()` / `respawnBackgroundChild()`

### Split contract

| Concern | Source on resume/retry |
|---|---|
| Extension allowlist (including injected multi-auth path) | Persisted launch metadata / extension entry written at initial launch |
| `PI_DELEGATED_AUTH_RUNTIME_DIR` (and any future non-secret overlay env) | **Re-call** `prepareSubagentAuth()` on every fresh process spawn |

Why re-call for env:

- Persisted agent frontmatter `env` does not include the broker overlay.
- Children may set `PI_CODING_AGENT_DIR`; without runtime-dir re-injection, multi-auth can load against the wrong root.
- Never persist arbitrary broker env maps; a future lease result may contain `PI_DELEGATED_AUTH_API_KEY`.

### Concrete hooks

1. Shared helper already owns registry discovery (`delegated-auth.ts`).
2. `buildBackgroundResumePlan()` must re-prepare auth and merge overlay env into the plan env (after `buildSubagentChildEnv`, broker last). Extension list still comes from persisted metadata.
3. Interactive resume in `resume-service.ts` must use the same env merge (extract a tiny shared “resume env + delegated overlay” helper if needed; do not fork logic).
4. Background retry already goes through `buildBackgroundResumePlan()` once that plan is fixed.

### Known adjacent resume quirk (out of scope unless touched)

When initial launch has `effectiveExtensions === undefined` (all extensions), resume currently falls back to:

```text
--no-extensions -e subagent-done.ts
```

That drops every normal extension, including multi-auth. The four OpenAI agents use explicit allowlists, so milestone-one acceptance is unaffected. Do not use an `extensions: all` agent for live validation of this fix.

## Lifecycle callbacks

The current `pi-multi-auth` broker returns self-managed mode, so release/report callbacks are **not** required for milestone one.

Before implementing lease mode, add lifecycle ownership:

- Keep non-secret broker metadata on `RunningSubagent`.
- Call `reportAttemptResult()` with the real exit code, timeout state, and stderr tail.
- Call `release()` exactly once after final completion, cancellation, launch failure, or parent shutdown.
- Decide whether background retry reports each attempt or only the final result; a lease-aware broker likely needs each attempt.

Do not add fake `timedOut: false` values. `src/runtime/background-watch.ts` currently terminates on timeout without exposing a timeout flag, so add real state if the callback needs it.

## Lease mode: defer until self-managed mode works

A real lease would let the parent reserve one account per child and prevent child processes from independently selecting credentials. It is useful later, but it expands scope and security risk.

Before enabling lease mode, `pi-multi-auth` must change `prepareSubagentAuth()` to call `KeyDistributor.acquireForSubagent()` and return the child variables consumed by `runtime-context.ts`.

Important gap: the current `lease` result type does not include `extensionDirs`. A leased child still needs `pi-multi-auth` loaded to interpret `PI_DELEGATED_AUTH_*`. Widen the contract or provide a generic child shim before enabling lease mode.

Security requirements:

- Never persist `PI_DELEGATED_AUTH_API_KEY`.
- Never include it in trace output, errors, session metadata, or test snapshots.
- Background spawn can pass it through `spawn(..., { env })`.
- Interactive launch currently builds a shell prefix (`KEY=value pi ...`); review mux/process visibility before passing secrets there. Milestone-one self-managed env is only a filesystem path and is safe in that prefix.
- Release leases on every terminal path.

## Tests to add

Use existing launch tests; avoid a broad new test framework.

Add a focused unit file with a fake `globalThis` registry:

- `test/launch/delegated-auth.test.ts`

Also cover coordinator + resume integration:

- `test/launch/launch-coordinator.test.ts`
- `test/launch/background-resume.test.ts`

Suggested cases:

1. **No registry:** launch args and env remain unchanged.
2. **Broker returns `none`:** unchanged.
3. **Explicit extension list + self-managed broker:**
   - `--no-extensions` remains;
   - existing `npm:pi-mcp-adapter` remains;
   - broker's absolute `pi-multi-auth` directory is added once;
   - mandatory `subagent-done.ts` remains.
4. **Seed extension entry + launch metadata** both contain the injected directory (mutation happened before seed).
5. **All extensions (`effectiveExtensions === undefined`):** keep undefined and do not switch to `--no-extensions`.
6. **Environment precedence:** broker env wins over agent frontmatter.
7. **Request mapping:** `openai-codex/gpt-5.6-luna` produces provider `openai-codex` and model `gpt-5.6-luna`.
8. **Absolute path validation:** relative `extensionDirs` entries are rejected.
9. **Background launch:** generated process env includes `PI_DELEGATED_AUTH_RUNTIME_DIR`.
10. **Interactive launch:** generated env prefix includes the runtime-dir key; trace data contains keys only, not values.
11. **Resume/retry:** persisted extensions keep the injected path; env overlay is re-applied via re-prepare (not by reading secrets from metadata).
12. **No duplicates:** an allowlist that already contains the extension stays unchanged.
13. **Lease result before support:** hard fail with a clear error; never silent partial auth.

Optional existing files if interactive env assembly is covered there:

- `test/launch/herdr-interactive-launch.test.ts`
- `test/launch/orca-interactive-launch.test.ts`

Run:

```bash
cd /Users/timhsia/Sync/Dev/pi-subagents
bunx tsc --noEmit
npm test
```

## Live acceptance test

1. Run Pi 0.80.10 with both local extensions enabled.
2. In `/multi-auth`, manually select a noncanonical Codex account such as `openai-codex-1`.
3. Make one parent Codex call and confirm the selected account is used.
4. Launch `luna-agent` and `gpt-agent` (explicit-allowlist agents only; not `extensions: all`).
5. Confirm each child loads `pi-multi-auth` without startup errors.
6. Confirm multi-auth debug output records the selected credential, not `openai-codex`.
7. Confirm the selected account's provider usage rises while the canonical primary account does not.
8. Resume one completed child and repeat the check (extension + runtime-dir both still effective).
9. Trigger one background retry if practical and confirm it does not lose the extension/auth overlay.

Do not log or paste token values during this test.

## Temporary workaround

Until the broker integration lands, add the local extension to each OpenAI agent allowlist using an **absolute** path (agent files live under `~/.pi/agent/agents/`, so repo-relative paths are wrong):

```yaml
extensions: npm:pi-mcp-adapter, /Users/timhsia/Sync/Dev/pi-multi-auth
```

Apply to:

- `~/.pi/agent/agents/luna-agent.md`
- `~/.pi/agent/agents/gpt-agent.md`
- `~/.pi/agent/agents/planner-agent.md`
- `~/.pi/agent/agents/review-agent.md`

This is machine-specific policy, not the final core fix. Do not use `extensions: all` as the permanent answer; it loads every user extension into each child and may expose extra tools or recursive subagent behavior. Also note: workaround alone does not inject `PI_DELEGATED_AUTH_RUNTIME_DIR`; it is usually enough when the child does not override `PI_CODING_AGENT_DIR` away from `~/.pi/agent`.

## Non-goals and rejected fixes

- Do not reorder `auth.json` whenever the user selects an account.
- Do not copy a backup credential into the canonical `openai-codex` slot.
- Do not change Pi core's auth resolver.
- Do not hard-code `/Users/timhsia/Sync/Dev/pi-multi-auth` in `pi-subagents` runtime code.
- Do not set lease-only vars (`PI_AGENT_ROUTER_SUBAGENT`, `PI_DELEGATED_AUTH_PROVIDER_ID`, `PI_DELEGATED_AUTH_LEASE_ID`, `PI_DELEGATED_AUTH_API_KEY`) in milestone one.
- Do not rely on the parent's in-memory `AccountManager`; child Pi is a separate process.
- Do not persist access tokens or arbitrary broker env maps in launch metadata.
- Do not implement lease mode before self-managed injection passes live validation.
- Do not add a parallel extensions field on the coordinated launch result; mutate `prepared.effectiveExtensions`.
- Do not apply the overlay after seed/metadata; seed and metadata must see the injected path.

## Milestone-one implementation checklist

1. Add `src/launch/delegated-auth.ts` (registry discover, validate, no env logging).
2. Wire `coordinateSubagentLaunch`: prepare → overlay → **mutate prepared extensions** → seed → metadata → base env → broker env last.
3. Wire `buildBackgroundResumePlan` + interactive resume env assembly: re-prepare overlay env; keep persisted extensions.
4. Unit + launch/resume tests listed above.
5. `bunx tsc --noEmit && npm test`.
6. Live Codex acceptance on a non-primary account, including one resume.

Skipped until later: lease mode, lifecycle `release` / `reportAttemptResult`, fixing the `extensions: undefined` resume collapse.

## Definition of done for milestone one

- OpenAI child agents load `pi-multi-auth` even when their definitions use an explicit extension allowlist.
- Seed extension entry and persisted launch metadata both include the injected extension path.
- A manual `/multi-auth` selection is honored by initial background and interactive children.
- Resume and background retry keep the same behavior (persisted extensions + re-prepared runtime-dir env).
- No secret appears in child command traces or session metadata.
- Existing extension/tool allowlist behavior remains unchanged apart from the broker-requested extension.
- `mode: "lease"` fails clearly rather than silently using primary auth.
- Existing `pi-subagents` tests pass.
- Live Codex usage confirms the selected nonprimary account receives child usage.
