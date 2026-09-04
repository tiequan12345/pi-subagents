import {
	existsSync,
	linkSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

type SignalBase = { outputTokens?: number };

export type SubagentExitSignal =
	| (SignalBase & { type: "done" })
	| (SignalBase & { type: "compacted" })
	| (SignalBase & { type: "ping"; name: string; message: string })
	| (SignalBase & {
			type: "error";
			errorMessage: string;
			stopReason: "error" | "toolUse";
		});

export function getSubagentExitSidecarPath(sessionFile: string): string {
	return `${sessionFile}.exit`;
}

export function writeSubagentExitSignal(
	sessionFile: string,
	signal: SubagentExitSignal,
	opts?: { supersede?: boolean },
): boolean {
	const exitFile = getSubagentExitSidecarPath(sessionFile);
	const hadExistingFile = existsSync(exitFile);
	if (hadExistingFile) {
		if (!opts?.supersede) return false;
		try {
			const existing = JSON.parse(readFileSync(exitFile, "utf8"));
			if (decodeSubagentExitSignal(existing).type !== "error") return false;
		} catch {
			// An unreadable sidecar cannot provide a terminal verdict. Replace it
			// with the complete signal below rather than leaving the child stuck.
		}
	}
	const tempFile = `${exitFile}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tempFile, JSON.stringify(signal), { encoding: "utf8", flag: "wx" });
		if (opts?.supersede && hadExistingFile) {
			renameSync(tempFile, exitFile);
			return true;
		}
		// A hard link atomically publishes the complete temp file without replacing
		// an existing signal when multiple processes race to finish first.
		try {
			linkSync(tempFile, exitFile);
			return true;
		} catch (error) {
			if (
				error !== null &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "EEXIST"
			) return false;
			throw error;
		}
	} finally {
		rmSync(tempFile, { force: true });
	}
}

export function decodeSubagentExitSignal(value: unknown): SubagentExitSignal {
	const malformed = (): SubagentExitSignal => ({
		type: "error",
		errorMessage: "Malformed or unknown subagent exit sidecar payload.",
		stopReason: "error",
	});
	if (!value || typeof value !== "object") return malformed();
	const data = value as Record<string, unknown>;
	const outputTokens =
		typeof data.outputTokens === "number" && Number.isFinite(data.outputTokens)
			? data.outputTokens
			: undefined;
	const withTokens = (signal: SubagentExitSignal): SubagentExitSignal =>
		outputTokens === undefined ? signal : { ...signal, outputTokens };

	switch (data.type) {
		case "done":
			return withTokens({ type: "done" });
		case "compacted":
			return withTokens({ type: "compacted" });
		case "ping":
			return typeof data.name === "string" && typeof data.message === "string"
				? withTokens({ type: "ping", name: data.name, message: data.message })
				: malformed();
		case "error":
			return typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
				? withTokens({
					type: "error",
					errorMessage: data.errorMessage,
					stopReason: data.stopReason === "toolUse" ? "toolUse" : "error",
				})
				: malformed();
		default:
			return malformed();
	}
}

export function clearSubagentExitSidecar(sessionFile: string): void {
	rmSync(getSubagentExitSidecarPath(sessionFile), { force: true });
}
