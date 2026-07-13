import { selectInteractiveCompletion } from "../../src/runtime/interactive-watch.ts";
import { assert, describe, it } from "../support/index.ts";

describe("interactive watcher completion protocol", () => {
	it("prefers one fallback sidecar result over every sentinel field", () => {
		const signal = {
			type: "error" as const,
			errorMessage: "child failed",
			stopReason: "error" as const,
			outputTokens: 37,
		};
		const completion = selectInteractiveCompletion(
			{ reason: "sentinel", exitCode: 0 },
			{
				reason: "error",
				exitCode: 1,
				errorMessage: signal.errorMessage,
				outputTokens: signal.outputTokens,
				ping: { name: "sidecar", message: "canonical" },
				signal,
			},
		);

		assert.deepEqual(completion, {
			reason: "error",
			exitCode: 1,
			errorMessage: "child failed",
			outputTokens: 37,
			ping: { name: "sidecar", message: "canonical" },
			signal,
		});
	});
});
