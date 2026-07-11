import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { defaultMuxRuntimeProbe } from "./runtime-probe.ts";

const ORCA_CLI = "orca";
const ORCA_TIMEOUT_MS = 10_000;

export class OrcaCommandError extends Error {
	readonly code?: string;

	constructor(message: string, code?: string) {
		super(message);
		this.name = "OrcaCommandError";
		this.code = code;
	}
}

const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function recordField(
	record: Record<string, unknown>,
	field: string,
): Record<string, unknown> | undefined {
	const value = record[field];
	return isRecord(value) ? value : undefined;
}

function stringField(
	record: Record<string, unknown> | undefined,
	field: string,
): string | undefined {
	const value = record?.[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function trimForError(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= 300) return trimmed;
	return `${trimmed.slice(0, 300)}…`;
}

function parseOrcaJson(operation: string, output: string): unknown {
	try {
		return JSON.parse(output);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Orca ${operation} returned malformed JSON: ${message}; output: ${trimForError(output) || "(empty)"}`,
		);
	}
}

function formatOrcaApiError(
	operation: string,
	error: unknown,
	fallback: string,
): OrcaCommandError {
	if (!isRecord(error)) {
		return new OrcaCommandError(`Orca ${operation} failed: ${fallback}`);
	}
	const code = typeof error.code === "string" ? error.code : undefined;
	const message =
		typeof error.message === "string" ? error.message : undefined;
	if (code && message) {
		return new OrcaCommandError(
			`Orca ${operation} failed: ${code}: ${message}`,
			code,
		);
	}
	if (message) {
		return new OrcaCommandError(
			`Orca ${operation} failed: ${message}`,
			code,
		);
	}
	if (code) {
		return new OrcaCommandError(`Orca ${operation} failed: ${code}`, code);
	}
	return new OrcaCommandError(`Orca ${operation} failed: ${fallback}`);
}

function runOrcaJson(operation: string, args: string[]): unknown {
	const result = spawnSync(ORCA_CLI, args, {
		encoding: "utf8",
		timeout: ORCA_TIMEOUT_MS,
	});

	if (result.error) {
		if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
			throw new Error(`Orca ${operation} timed out after ${ORCA_TIMEOUT_MS}ms`);
		}
		throw new Error(
			`Orca ${operation} failed to start: ${result.error.message}`,
		);
	}

	const output =
		(typeof result.stdout === "string" ? result.stdout : "").trim() ||
		(typeof result.stderr === "string" ? result.stderr : "").trim();

	if (!output) {
		if (typeof result.status === "number" && result.status !== 0) {
			throw new Error(
				`Orca ${operation} failed with exit code ${result.status}: (no output)`,
			);
		}
		throw new Error(`Orca ${operation} returned no JSON output`);
	}

	let parsed: unknown;
	try {
		parsed = parseOrcaJson(operation, output);
	} catch (error) {
		if (typeof result.status === "number" && result.status !== 0) {
			throw new Error(
				`Orca ${operation} failed with exit code ${result.status}: ${trimForError(output)}`,
			);
		}
		throw error;
	}

	if (isRecord(parsed) && "error" in parsed) {
		throw formatOrcaApiError(operation, parsed.error, trimForError(output));
	}

	if (typeof result.status === "number" && result.status !== 0) {
		throw new Error(
			`Orca ${operation} failed with exit code ${result.status}: ${trimForError(output)}`,
		);
	}

	return parsed;
}

function runOrcaApi(
	operation: string,
	args: string[],
): Record<string, unknown> {
	const envelope = runOrcaJson(operation, args);
	if (!isRecord(envelope)) {
		throw new Error(`Orca ${operation} returned malformed API envelope`);
	}
	const result = envelope.result;
	if (!isRecord(result)) {
		throw new Error(
			`Orca ${operation} returned malformed API envelope: missing result`,
		);
	}
	return result;
}

async function runOrcaJsonAsync(
	operation: string,
	args: string[],
): Promise<unknown> {
	try {
		const { stdout } = await execFileAsync(ORCA_CLI, args, {
			encoding: "utf8",
			timeout: ORCA_TIMEOUT_MS,
		});

		const output = stdout.trim();
		if (!output) {
			throw new Error(`Orca ${operation} returned no JSON output`);
		}

		const parsed = parseOrcaJson(operation, output);

		if (isRecord(parsed) && "error" in parsed) {
			throw formatOrcaApiError(
				operation,
				parsed.error,
				trimForError(output),
			);
		}

		return parsed;
	} catch (error) {
		if (error instanceof OrcaCommandError) throw error;
		if ((error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
			throw new Error(
				`Orca ${operation} timed out after ${ORCA_TIMEOUT_MS}ms`,
			);
		}
		const execError = error as Error & {
			stdout?: string;
			stderr?: string;
		};
		const output =
			(typeof execError.stdout === "string" ? execError.stdout : "")
				.trim() ||
			(typeof execError.stderr === "string" ? execError.stderr : "")
				.trim();
		if (output) {
			try {
				const parsed = parseOrcaJson(operation, output);
				if (isRecord(parsed) && "error" in parsed) {
					throw formatOrcaApiError(
						operation,
						parsed.error,
						trimForError(output),
					);
				}
			} catch (parseOrApiError) {
				if (parseOrApiError instanceof OrcaCommandError) throw parseOrApiError;
			}
		}
		throw new Error(
			`Orca ${operation} failed: ${trimForError(output || execError.message)}`,
		);
	}
}

async function runOrcaApiAsync(
	operation: string,
	args: string[],
): Promise<Record<string, unknown>> {
	const envelope = await runOrcaJsonAsync(operation, args);
	if (!isRecord(envelope)) {
		throw new Error(`Orca ${operation} returned malformed API envelope`);
	}
	const result = envelope.result;
	if (!isRecord(result)) {
		throw new Error(
			`Orca ${operation} returned malformed API envelope: missing result`,
		);
	}
	return result;
}

export function isOrcaStaleHandle(error: unknown): boolean {
	return (
		error instanceof OrcaCommandError &&
		(error.code === "terminal_handle_stale" ||
			error.code === "terminal_not_found")
	);
}

export function isOrcaRuntimeAvailable(
	hasCommand?: (command: string) => boolean,
): boolean {
	const checkCommand =
		hasCommand ??
		((cmd: string) => defaultMuxRuntimeProbe.hasCommand(cmd));
	if (!checkCommand(ORCA_CLI)) return false;
	try {
		const result = runOrcaApi("status", ["status", "--json"]);
		// Accept ok === true + runtime.reachable or app.running.
		const runtime = recordField(result, "runtime");
		const app = recordField(result, "app");
		return runtime?.reachable === true || app?.running === true;
	} catch {
		return false;
	}
}

export function isOrcaAvailable(
	hasCommand?: (command: string) => boolean,
): boolean {
	if (!isOrcaRuntimeAvailable(hasCommand)) return false;
	// Require current worktree to confirm we're inside an Orca-managed session
	try {
		runOrcaApi("worktree current", ["worktree", "current", "--json"]);
		return true;
	} catch {
		return false;
	}
}

export function createOrcaTerminal(
	title: string,
	worktreeSelector = "active",
): string {
	const result = runOrcaApi("terminal create", [
		"terminal",
		"create",
		"--worktree",
		worktreeSelector,
		"--title",
		title,
		"--json",
	]);
	const handle = stringField(recordField(result, "terminal"), "handle");
	if (!handle) {
		throw new Error(
			"Orca terminal create returned missing or empty terminal handle",
		);
	}
	return handle;
}

export function splitOrcaTerminal(
	handle: string,
	direction: "horizontal" | "vertical",
): string {
	const result = runOrcaApi("terminal split", [
		"terminal",
		"split",
		"--terminal",
		handle,
		"--direction",
		direction,
		"--json",
	]);
	const newHandle =
		stringField(recordField(result, "split"), "handle") ??
		stringField(recordField(result, "terminal"), "handle");
	if (!newHandle) {
		throw new Error(
			"Orca terminal split returned missing or empty terminal handle",
		);
	}
	return newHandle;
}

function sendOrcaText(handle: string, text: string): void {
	runOrcaVoid("terminal send", [
		"terminal",
		"send",
		"--terminal",
		handle,
		"--text",
		text,
		"--enter",
		"--json",
	]);
}

function runOrcaVoid(operation: string, args: string[]): void {
	const result = spawnSync(ORCA_CLI, args, {
		encoding: "utf8",
		timeout: ORCA_TIMEOUT_MS,
	});

	if (result.error) {
		if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
			throw new Error(
				`Orca ${operation} timed out after ${ORCA_TIMEOUT_MS}ms`,
			);
		}
		throw new Error(
			`Orca ${operation} failed to start: ${result.error.message}`,
		);
	}

	const output =
		(typeof result.stdout === "string" ? result.stdout : "").trim() ||
		(typeof result.stderr === "string" ? result.stderr : "").trim();

	if (output) {
		let parsed: unknown;
		try {
			parsed = parseOrcaJson(operation, output);
		} catch (error) {
			if (typeof result.status === "number" && result.status !== 0) {
				throw new Error(
					`Orca ${operation} failed with exit code ${result.status}: ${trimForError(output)}`,
				);
			}
			throw error;
		}
		if (isRecord(parsed) && "error" in parsed) {
			throw formatOrcaApiError(
				operation,
				parsed.error,
				trimForError(output),
			);
		}
	}

	if (typeof result.status === "number" && result.status !== 0) {
		throw new Error(
			`Orca ${operation} failed with exit code ${result.status}: ${trimForError(output) || "(empty)"}`,
		);
	}
}

export function sendOrcaCommand(handle: string, command: string): void {
	// Pass --text <command> plus --enter. Empty command sends bare Enter.
	// Do NOT append extra newline — --enter handles the Enter keypress.
	sendOrcaText(handle, command);
}

function readOrcaScreenRaw(handle: string): string[] {
	const result = runOrcaApi("terminal read", [
		"terminal",
		"read",
		"--terminal",
		handle,
		"--json",
	]);
	const tail = recordField(result, "terminal")?.tail;
	if (!Array.isArray(tail)) {
		throw new Error(
			"Orca terminal read returned malformed result: missing terminal.tail array",
		);
	}
	return tail as string[];
}

export function readOrcaTerminalScreen(
	handle: string,
	lines: number,
): string {
	const tail = readOrcaScreenRaw(handle);
	const text = tail.join("\n");
	const split = text.split("\n");
	if (split.length <= lines) return text;
	return split.slice(-lines).join("\n");
}

async function readOrcaScreenRawAsync(handle: string): Promise<string[]> {
	const result = await runOrcaApiAsync("terminal read", [
		"terminal",
		"read",
		"--terminal",
		handle,
		"--json",
	]);
	const tail = recordField(result, "terminal")?.tail;
	if (!Array.isArray(tail)) {
		throw new Error(
			"Orca terminal read returned malformed result: missing terminal.tail array",
		);
	}
	return tail as string[];
}

export async function readOrcaTerminalScreenAsync(
	handle: string,
	lines: number,
): Promise<string> {
	const tail = await readOrcaScreenRawAsync(handle);
	const text = tail.join("\n");
	const split = text.split("\n");
	if (split.length <= lines) return text;
	return split.slice(-lines).join("\n");
}

export function closeOrcaTerminal(handle: string): void {
	try {
		runOrcaVoid("terminal close", [
			"terminal",
			"close",
			"--terminal",
			handle,
			"--json",
		]);
	} catch (error) {
		if (isOrcaStaleHandle(error)) return;
		throw error;
	}
}

export function renameOrcaTerminal(handle: string, title: string): void {
	runOrcaApi("terminal rename", [
		"terminal",
		"rename",
		"--terminal",
		handle,
		"--title",
		title,
		"--json",
	]);
}

export function getOrcaTerminalWorktreeId(handle: string): string | undefined {
	const result = runOrcaApi("terminal list", ["terminal", "list", "--json"]);
	const terminals = result.terminals;
	if (!Array.isArray(terminals)) return undefined;
	for (const terminal of terminals) {
		if (!isRecord(terminal)) continue;
		if (stringField(terminal, "handle") === handle) {
			return stringField(terminal, "worktreeId");
		}
	}
	return undefined;
}

export function renameOrcaWorktreeDisplayName(
	title: string,
	worktreeSelector = "active",
): void {
	runOrcaApi("worktree set", [
		"worktree",
		"set",
		"--worktree",
		worktreeSelector,
		"--display-name",
		title,
		"--json",
	]);
}
