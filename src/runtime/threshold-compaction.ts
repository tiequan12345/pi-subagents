import type { SubagentExitSignal } from "../session/exit-sidecar.ts";

export type ThresholdCompactionState = "idle" | "attempted" | "compacted";

export function beginThresholdCompaction(): ThresholdCompactionState {
	return "attempted";
}

export function completeThresholdCompaction(): ThresholdCompactionState {
	return "compacted";
}

export function getThresholdCompactionExitSignal(
	state: ThresholdCompactionState,
	outputTokens: number,
): SubagentExitSignal | undefined {
	if (state === "compacted") return { type: "compacted", outputTokens };
	if (state === "attempted") {
		return {
			type: "error",
			errorMessage:
				"Threshold compaction failed or was aborted; the task may be incomplete.",
			stopReason: "error",
			outputTokens,
		};
	}
	return undefined;
}
