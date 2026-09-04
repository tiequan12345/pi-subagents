import {
	assert,
	afterEach,
	describe,
	getCompletedSubagentResultForTest,
	it,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
} from "../support/index.ts";
import { routeSubagentOutcome, escalateIfUndelivered, setSessionEntriesReader } from "../../src/runtime/result-router.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";

function makeRunning(overrides: Partial<RunningSubagent> = {}): RunningSubagent {
	return {
		id: "child-result-router",
		name: "Result child",
		task: "Report result",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile: "/tmp/result-child.jsonl",
		...overrides,
	};
}

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		name: "Result child",
		task: "Report result",
		summary: "Finished the delegated work.",
		summarySource: "subagent",
		sessionFile: "/tmp/result-child.jsonl",
		exitCode: 0,
		elapsed: 3,
		...overrides,
	};
}

describe("result router", () => {
	afterEach(() => {
		resetSubagentStateForTest();
		setSessionEntriesReader(undefined);
	});

	describe("delivery verification", () => {
		function makeSent() {
			const sent: Array<{ message: any; options: any }> = [];
			return {
				sent,
				pi: {
					sendMessage() {},
					sendUserMessage(content: any, options: any) {
						sent.push({ message: content, options });
					},
				},
			};
		}

		function makeCompleted() {
			const running = makeRunning();
			const routed = routeSubagentOutcome({
				pi: { sendMessage() {}, sendUserMessage() {} },
				running,
				result: makeResult(),
				formatElapsed: (seconds) => `${seconds}s`,
				updateWidget: () => {},
			});
			if (routed.kind !== "completion") throw new Error("expected completion");
			return routed.completed;
		}

		it("escalates as a user message when the routed result never landed", () => {
			setSessionEntriesReader(() => []); // nothing persisted
			const { pi, sent } = makeSent();
			const completed = makeCompleted();

			const escalated = escalateIfUndelivered(pi, completed, (seconds) => `${seconds}s`);

			assert.equal(escalated, true);
			assert.equal(sent.length, 1);
			assert.match(String(sent[0].message), /Result child/);
			assert.match(String(sent[0].message), /Delivery check/);
			assert.deepEqual(sent[0].options, { deliverAs: "steer" });
		});

		it("stays silent when the result landed in the session", () => {
			const completed = makeCompleted();
			setSessionEntriesReader(() => [
				{ type: "custom_message", customType: "subagent_result", details: { id: completed.id } },
			]);
			const { pi, sent } = makeSent();

			const escalated = escalateIfUndelivered(pi, completed, (seconds) => `${seconds}s`);

			assert.equal(escalated, false);
			assert.equal(sent.length, 0);
		});

		it("stays silent when session entries are unavailable", () => {
			setSessionEntriesReader(() => undefined);
			const { pi, sent } = makeSent();
			const completed = makeCompleted();

			const escalated = escalateIfUndelivered(pi, completed, (seconds) => `${seconds}s`);

			assert.equal(escalated, false);
			assert.equal(sent.length, 0);
		});

		it("never escalates results claimed by the wait tool", () => {
			setSessionEntriesReader(() => []); // nothing persisted — ownership must still win
			const completed = makeCompleted();
			completed.deliveredTo = "wait";
			const { pi, sent } = makeSent();

			const escalated = escalateIfUndelivered(pi, completed, (seconds) => `${seconds}s`);

			assert.equal(escalated, false);
			assert.equal(sent.length, 0);
		});

		it("escalates at most once across both scheduled checks (latch)", (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			setSessionEntriesReader(() => []); // nothing ever lands
			const escalations: string[] = [];
			const running = makeRunning();
			routeSubagentOutcome({
				pi: {
					sendMessage() {},
					sendUserMessage(content: any) {
						escalations.push(String(content));
					},
				},
				running,
				result: makeResult(),
				formatElapsed: (seconds) => `${seconds}s`,
				updateWidget: () => {},
			});

			t.mock.timers.tick(8_000);
			assert.equal(escalations.length, 1);
			t.mock.timers.tick(17_000); // second check must not re-send
			assert.equal(escalations.length, 1);
		});
	});

	it("routes detached completion through one parent-visible result", () => {
		const sent: Array<{ message: any; options: any }> = [];
		let widgetUpdates = 0;
		const running = makeRunning();
		setRunningSubagentForTest(running);

		const routed = routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult(),
			formatElapsed: (seconds) => `${seconds}s`,
			updateWidget: () => {
				widgetUpdates += 1;
			},
		});

		assert.equal(routed.kind, "completion");
		assert.equal(routed.completed.status, "completed");
		assert.equal(routed.completed.deliveredTo, "steer");
		assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "steer");
		assert.equal(widgetUpdates, 1);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].message.customType, "subagent_result");
		assert.equal(sent[0].message.details.id, running.id);
		assert.equal(sent[0].message.details.deliveryState, "detached");
		assert.equal(sent[0].message.details.status, "completed");
		assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: "steer" });
	});

	it("delivers salvaged child output with provider errors", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning();
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				summary: "Completed the requested implementation.",
				summarySource: "subagent",
				errorMessage: "Provider unavailable",
			}),
			formatElapsed: (seconds) => `${seconds}s`,
			updateWidget: () => {},
		});

		assert.match(sent[0].message.content, /Last output before the failure/);
		assert.match(sent[0].message.content, /Completed the requested implementation\./);
		assert.doesNotMatch(sent[0].message.content, /did not produce a result/);
	});

	it("does not surface a watcher fallback as salvaged output", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning();
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				summary: "Background agent exited with code 1\n\nprovider stack trace",
				summarySource: "runtime",
				errorMessage: "Provider unavailable",
			}),
			formatElapsed: (seconds) => `${seconds}s`,
			updateWidget: () => {},
		});

		assert.match(sent[0].message.content, /did not produce a result/);
		assert.doesNotMatch(sent[0].message.content, /Last output before the failure/);
		assert.doesNotMatch(sent[0].message.content, /provider stack trace/);
	});

	it("routes child pings without caching a completed result", () => {
		const sent: Array<{ message: any; options: any }> = [];
		let widgetUpdates = 0;
		const running = makeRunning();
		setRunningSubagentForTest(running);

		const routed = routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				ping: {
					name: "Result child",
					message: "Need parent input.",
				},
			}),
			formatElapsed: (seconds) => `${seconds}s`,
			updateWidget: () => {
				widgetUpdates += 1;
			},
		});

		assert.equal(routed.kind, "ping");
		assert.equal(getCompletedSubagentResultForTest(running.id), undefined);
		assert.equal(widgetUpdates, 1);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].message.customType, "subagent_ping");
		assert.equal(sent[0].message.details.id, running.id);
		assert.equal(sent[0].message.details.message, "Need parent input.");
		assert.match(sent[0].message.content, /Need parent input\./);
		assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: "steer" });
	});
});
