import { appendFileSync } from "node:fs";
import {
	beginThresholdCompaction,
	completeThresholdCompaction,
	getThresholdCompactionExitSignal,
} from "../../../src/runtime/threshold-compaction.ts";
import { writeSubagentExitSignal } from "../../../src/session/exit-sidecar.ts";

const [sessionFile, phase] = process.argv.slice(2);
if (!sessionFile || !phase) throw new Error("session file and phase are required");

await new Promise((resolve) => setTimeout(resolve, 50));
if (phase === "compact") {
	let state = beginThresholdCompaction();
	state = completeThresholdCompaction();
	const signal = getThresholdCompactionExitSignal(state, 11);
	if (!signal) throw new Error("missing compacted signal");
	writeSubagentExitSignal(sessionFile, signal);
} else {
	appendFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "RESUMED_COMPLETE" }],
			},
		})}\n`,
	);
	writeSubagentExitSignal(sessionFile, { type: "done", outputTokens: 23 });
}
