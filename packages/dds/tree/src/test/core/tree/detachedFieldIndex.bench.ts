/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import {
	BenchmarkMode,
	benchmarkDuration,
	benchmarkDurationBatchless,
	benchmarkIt,
	benchmarkMemoryUse,
	currentBenchmarkMode,
	memoryUseOfValue,
} from "@fluid-tools/benchmark";

import { makeDetachedFieldIndex } from "../../../core/index.js";
import { configureBenchmarkHooks, mintRevisionTag } from "../../utils.js";

const revisionA = mintRevisionTag();
const revisionB = mintRevisionTag();
const revisionC = mintRevisionTag();

/**
 * Splits lifetimes, not forest fields, so ID count and record count can vary independently.
 */
function fragmentedIndex(size: number, fragments: number) {
	const index = makeDetachedFieldIndex("benchmark");
	const root = index.createRange({ minor: 0 }, revisionA, size);
	const width = size / fragments;
	for (let fragment = 1; fragment < fragments; fragment += 2) {
		index.updateLatestRevision({ minor: fragment * width }, revisionB, width);
	}
	assert.equal([...index.ranges()].length, fragments);
	return { index, root };
}

describe("DetachedFieldIndex range benchmarks", () => {
	configureBenchmarkHooks();
	const performanceMode = currentBenchmarkMode === BenchmarkMode.Performance;
	const sizes = performanceMode ? [1024, 65536] : [16];
	const maxBenchmarkDurationSeconds = 5;

	// Both representations use the new index API. This is not an old-index/new-index comparison.
	for (const size of sizes) {
		for (const singleton of [false, true]) {
			const name = `${size} IDs, ${singleton ? size : 1} fields`;
			const create = () => {
				const index = makeDetachedFieldIndex("benchmark");
				const width = singleton ? 1 : size;
				for (let minor = 0; minor < size; minor += width) {
					index.createRange({ minor }, revisionA, width);
				}
				return index;
			};
			benchmarkIt({
				title: `register ${name}`,
				...benchmarkDuration({
					benchmarkFnCustom: async (state) => {
						let result = create();
						state.timeAllBatches(() => {
							result = create();
						});
						assert.equal([...result.ranges()].length, singleton ? size : 1);
						assert.equal(
							result.getLocation({ minor: size - 1 }).index,
							singleton ? 0 : size - 1,
						);
					},
					maxBenchmarkDurationSeconds,
				}),
			});
			benchmarkIt({
				title: `retained index heap: ${name}`,
				...benchmarkMemoryUse({
					...memoryUseOfValue(create),
					warmUpIterations: 2,
					keepIterations: 6,
				}),
			});
		}
	}

	for (const size of performanceMode ? [...sizes, 1048576] : sizes) {
		for (const fragments of performanceMode ? [1, 64] : [1, 4]) {
			const name = `${size} IDs, ${fragments} lifetime fragments, one field`;
			benchmarkIt({
				title: `retained index heap: ${name}`,
				...benchmarkMemoryUse({
					...memoryUseOfValue(() => fragmentedIndex(size, fragments).index),
					warmUpIterations: 2,
					keepIterations: 6,
				}),
			});
			for (const query of ["point", "prefix"] as const) {
				benchmarkIt({
					title: `${query} lookup: ${name}`,
					...benchmarkDuration({
						benchmarkFnCustom: async (state) => {
							const { index, root } = fragmentedIndex(size, fragments);
							let result = 0;
							state.timeAllBatches(() => {
								result =
									query === "point"
										? index.getLocation({ minor: size / 2 }).index
										: index.getFirst({ minor: 0 }, size).length;
							});
							assert.equal(result, query === "point" ? size / 2 : size);
							assert.equal(index.getLocation({ minor: 0 }).root, root);
						},
						maxBenchmarkDurationSeconds,
					}),
				});
			}

			benchmarkIt({
				title: `clone: ${name}`,
				...benchmarkDuration({
					benchmarkFnCustom: async (state) => {
						const { index } = fragmentedIndex(size, fragments);
						let result = index;
						state.timeAllBatches(() => {
							result = index.clone();
						});
						assert.notEqual(result, index);
						assert.deepEqual([...result.ranges()], [...index.ranges()]);
						result.purge();
						assert.equal(index.getFirst({ minor: 0 }, size).length, size);
					},
					maxBenchmarkDurationSeconds,
				}),
			});

			for (const edit of ["clip middle half", "split revision"] as const) {
				benchmarkIt({
					title: `${edit}: ${name}`,
					...benchmarkDurationBatchless({
						benchmarkFn: (state) => {
							const original = fragmentedIndex(size, fragments);
							let running: boolean;
							do {
								// Neither cloning nor per-fragment construction is timed.
								const index = original.index.clone();
								running = state.time(() => {
									if (edit === "clip middle half") {
										index.deleteRange(original.root, { start: size / 4, end: (3 * size) / 4 });
									} else {
										index.updateLatestRevision({ minor: size / 2 }, revisionC);
									}
								});
								if (edit === "clip middle half") {
									assert.equal(index.tryGetLocation({ minor: size / 2 }), undefined);
									assert.equal(index.getLocation({ minor: (3 * size) / 4 }).index, size / 4);
									assert.equal(index.getLocation({ minor: size - 1 }).index, size / 2 - 1);
								} else {
									assert.deepEqual(
										[...index.getRangesLastTouchedByRevision(revisionC)],
										[{ id: { minor: size / 2 }, count: 1 }],
									);
								}
							} while (running);
						},
						minSampleCount: 30,
						maxBenchmarkDurationSeconds,
					}),
				});
			}
		}
	}
});
