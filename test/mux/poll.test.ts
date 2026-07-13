import { assert, describe, it } from "../support/index.ts";
import { __pollForExitTest__ } from "../../src/mux/poll.ts";

describe("interpretExitSidecar", () => {
	const { interpretExitSidecar } = __pollForExitTest__;

	it("decodes each typed signal without losing its discriminant", () => {
		for (const signal of [
			{ type: "done" as const },
			{ type: "compacted" as const, outputTokens: 9 },
			{ type: "ping" as const, name: "Worker", message: "need help" },
			{
				type: "error" as const,
				errorMessage: "Anthropic 529 Overloaded",
				stopReason: "error" as const,
			},
		]) {
			const result = interpretExitSidecar(signal);
			assert.deepEqual(result.signal, signal);
			assert.equal(result.reason, signal.type);
		}
	});

	it("decodes compacted as a successful lifecycle boundary", () => {
		const result = interpretExitSidecar({ type: "compacted", outputTokens: 42 });
		assert.equal(result.reason, "compacted");
		assert.equal(result.exitCode, 0);
		assert.equal(result.outputTokens, 42);
		assert.equal(result.signal?.type, "compacted");
	});

	it("fails closed for malformed and unknown payloads", () => {
		for (const payload of [undefined, {}, { type: "future" }, { type: "ping" }]) {
			const result = interpretExitSidecar(payload);
			assert.equal(result.reason, "error");
			assert.equal(result.exitCode, 1);
			assert.equal(result.signal?.type, "error");
			assert.match(result.errorMessage ?? "", /Malformed or unknown/);
		}
	});

	it("threads outputTokens through done payloads", () => {
		const result = interpretExitSidecar({ type: "done", outputTokens: 42 });
		assert.equal(result.outputTokens, 42);
	});
});
