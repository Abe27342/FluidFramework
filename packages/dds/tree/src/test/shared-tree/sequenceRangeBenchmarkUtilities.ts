/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import {
	BenchmarkMode,
	benchmarkDurationBatchless,
	benchmarkIt,
	benchmarkMemoryUse,
	currentBenchmarkMode,
	memoryAddedBy,
} from "@fluid-tools/benchmark";
import type { IChannelFactory } from "@fluidframework/datastore-definitions/internal";

import type { Revertible } from "../../core/index.js";
import { SchemaFactory, TreeViewConfiguration, type ITree } from "../../simple-tree/index.js";
import { configureBenchmarkHooks, TestTreeProviderLite } from "../utils.js";

const sf = new SchemaFactory("sequence range benchmarks");
class Numbers extends sf.array("Numbers", sf.number) {}
const config = new TreeViewConfiguration({ schema: Numbers });

type Edit = "delete" | "undo" | "move" | "remote delete";

/**
 * Registers public-API workloads without depending on the detached-field index or its batching policy.
 * @remarks
 * Local timings include authoring and submission, but not acknowledgement.
 * Remote timings drain only a paused receiver, with no concurrent local edit.
 * Construction, sender work, validation, and disposal are outside timing.
 * Deletion heap measurements include retained undo/repair data and the pending outgoing op,
 * not just the index, and measure incremental retained heap after GC rather than peak allocations.
 */
export function sequenceRangeBenchmarks(name: string, factory: IChannelFactory<ITree>): void {
	describe(`Sequence range edits: ${name}`, () => {
		configureBenchmarkHooks();
		const sizes =
			currentBenchmarkMode === BenchmarkMode.Performance
				? [
						{ size: 1000, count: 100 },
						{ size: 10000, count: 100 },
						{ size: 10000, count: 5000 },
						{ size: 10000, count: 10000 },
						{ size: 65536, count: 65536 },
					]
				: [
						{ size: 16, count: 4 },
						{ size: 16, count: 16 },
					];

		for (const { size, count } of sizes) {
			const start = Math.floor((size - count) / 2);
			const end = start + count;
			const edits: readonly Edit[] =
				count === size ? ["delete", "undo"] : ["delete", "undo", "move", "remote delete"];

			function setup(edit: Edit) {
				const provider = new TestTreeProviderLite(edit === "remote delete" ? 2 : 1, factory);
				const sender = provider.trees[0].viewWith(config);
				const content = Array.from({ length: size }, (_, index) => index);
				sender.initialize(content);
				provider.synchronizeMessages();
				const view = edit === "remote delete" ? provider.trees[1].viewWith(config) : sender;
				let undo: Revertible | undefined;
				// Capture exactly the deletion's revertible; undo must not create another retained handle.
				const unsubscribe = view.events.on("commitApplied", (_commit, getRevertible) => {
					if (undo === undefined && getRevertible !== undefined) {
						undo = getRevertible();
					}
				});
				if (edit === "undo") {
					view.root.removeRange(start, end);
					unsubscribe();
					assert(undo !== undefined);
				} else if (edit === "remote delete") {
					provider.trees[1].containerRuntime.pauseInboundProcessing();
					sender.root.removeRange(start, end);
					provider.synchronizeMessages();
					assert.equal(view.root.length, size);
				}

				return {
					run: () => {
						switch (edit) {
							case "delete": {
								view.root.removeRange(start, end);
								break;
							}
							case "undo": {
								assert(undo !== undefined);
								undo.revert();
								undo = undefined;
								break;
							}
							case "move": {
								view.root.moveRangeToIndex(0, start, end);
								break;
							}
							case "remote delete": {
								provider.trees[1].containerRuntime.resumeInboundProcessing();
								break;
							}
							default: {
								assert.fail("Unknown sequence edit");
							}
						}
					},
					verify: () => {
						const expected =
							edit === "undo"
								? content
								: edit === "move"
									? [
											...content.slice(start, end),
											...content.slice(0, start),
											...content.slice(end),
										]
									: [...content.slice(0, start), ...content.slice(end)];
						assert.deepEqual([...view.root], expected);
						if (edit === "delete") {
							assert(undo !== undefined);
						}
					},
					dispose: () => {
						unsubscribe();
						undo?.dispose();
						view.dispose();
						if (view !== sender) {
							sender.dispose();
						}
					},
				};
			}

			for (const edit of edits) {
				benchmarkIt({
					title: `${edit}: document ${size}, span ${count}`,
					...benchmarkDurationBatchless({
						benchmarkFn: (state) => {
							let running: boolean;
							do {
								const fixture = setup(edit);
								running = state.time(fixture.run);
								fixture.verify();
								fixture.dispose();
							} while (running);
						},
						minSampleCount: 30,
						maxBenchmarkDurationSeconds: 5,
					}),
				});
			}

			if (count === size) {
				benchmarkIt({
					title: `delete retained heap: document ${size}, span ${count}`,
					...benchmarkMemoryUse({
						...memoryAddedBy({
							setup: () => setup("delete"),
							modify: (fixture) => fixture.run(),
							after: (fixture) => {
								fixture.verify();
								fixture.dispose();
							},
						}),
						warmUpIterations: 2,
						keepIterations: 6,
					}),
				});
			}
		}
	});
}
