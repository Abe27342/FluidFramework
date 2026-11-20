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
	ValueType,
	type CollectedData,
} from "@fluid-tools/benchmark";

import {
	combineVisitors,
	createAnnouncedVisitor,
	makeDetachedFieldIndex,
	rootFieldKey,
	TreeStoredSchemaRepository,
	visitDelta,
	type DeltaRoot,
} from "../../../core/index.js";
import {
	buildChunkedForest,
	defaultIncrementalEncodingPolicy,
	defaultSchemaPolicy,
	makeTreeChunker,
} from "../../../feature-libraries/index.js";
import {
	TreeShape,
	UniformChunk,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../feature-libraries/chunked-forest/uniformChunk.js";
import { numberSchema } from "../../../simple-tree/index.js";
import { brand } from "../../../util/index.js";
import { jsonSequenceRootSchema } from "../../sequenceRootUtils.js";
import { configureBenchmarkHooks } from "../../utils.js";

/**
 * Uses a real forest and index but excludes change authoring, encoding, and checkout history.
 * Both batching policies start with the same single prebuilt UniformChunk.
 */
function fixture(
	size: number,
	count: number,
	grouped: boolean,
	context: "unanchored" | "sparse anchors" | "sparse anchors, shared",
) {
	const start = (size - count) / 2;
	const schema = new TreeStoredSchemaRepository(jsonSequenceRootSchema);
	const forest = buildChunkedForest(
		makeTreeChunker(schema, defaultSchemaPolicy, defaultIncrementalEncodingPolicy),
	);
	const shape = new TreeShape(brand(numberSchema.identifier), true, []);
	const chunk = new UniformChunk(
		shape.withTopLevelLength(size),
		Array.from({ length: size }, (_, position) => position),
	);
	forest.roots.fields.set(rootFieldKey, [chunk]);
	const snapshot = context === "sparse anchors, shared" ? forest.clone(schema) : undefined;
	const tracked =
		context === "unanchored"
			? []
			: [...new Set([0, start, start + count / 2, start + count - 1, size - 1])].map(
					(position) => ({
						position,
						anchor: forest.anchors.track({
							parent: undefined,
							parentField: rootFieldKey,
							parentIndex: position,
						}),
					}),
				);
	const index = makeDetachedFieldIndex("benchmark");
	const delta: DeltaRoot = {
		fields: new Map([
			[
				rootFieldKey,
				{
					marks: [...(start === 0 ? [] : [{ count: start }]), { count, detach: { minor: 0 } }],
				},
			],
		]),
	};
	return {
		run: () => {
			const visitor =
				context === "unanchored"
					? forest.acquireVisitor()
					: combineVisitors([forest.acquireVisitor(), forest.anchors.acquireVisitor()]);
			visitDelta(delta, visitor, index, undefined, grouped);
			visitor.free();
		},
		measureWork: () => {
			let detaches = 0;
			const visitor = combineVisitors([
				forest.acquireVisitor(),
				forest.anchors.acquireVisitor(),
				createAnnouncedVisitor({ detach: () => detaches++ }),
			]);
			visitDelta(delta, visitor, index, undefined, grouped);
			visitor.free();
			return detaches;
		},
		verify: () => {
			const ranges = [...index.ranges()];
			assert.equal(ranges.length, grouped ? 1 : count);
			assert.equal(
				ranges.reduce((total, range) => total + range.count, 0),
				count,
			);
			assert.equal(forest.roots.fields.size, (grouped ? 1 : count) + (size === count ? 0 : 1));
			for (const range of ranges) {
				const detachedCursor = forest.getCursorAboveDetachedFields();
				detachedCursor.enterField(index.toFieldKey(range.root));
				assert.equal(detachedCursor.getFieldLength(), range.count);
				for (let offset = 0; offset < range.count; offset++) {
					detachedCursor.enterNode(offset);
					assert.equal(detachedCursor.value, start + range.id.minor + offset);
					detachedCursor.exitNode();
				}
			}
			const cursor = forest.getCursorAboveDetachedFields();
			cursor.enterField(rootFieldKey);
			assert.equal(cursor.getFieldLength(), size - count);
			for (let position = 0; position < size - count; position++) {
				cursor.enterNode(position);
				assert.equal(cursor.value, position < start ? position : position + count);
				cursor.exitNode();
			}
			for (const { position, anchor } of tracked) {
				const path = forest.anchors.locate(anchor);
				assert(path !== undefined);
				if (position >= start && position < start + count) {
					assert.deepEqual(path.detachedNodeId, { minor: position - start });
				} else {
					assert.equal(path.parentIndex, position < start ? position : position - count);
				}
			}
			if (snapshot !== undefined) {
				const snapshotCursor = snapshot.getCursorAboveDetachedFields();
				snapshotCursor.enterField(rootFieldKey);
				assert.equal(snapshotCursor.getFieldLength(), size);
				for (let position = 0; position < size; position++) {
					snapshotCursor.enterNode(position);
					assert.equal(snapshotCursor.value, position);
					snapshotCursor.exitNode();
				}
			}
			return { ranges: ranges.length, fields: forest.roots.fields.size };
		},
		dispose: () => {
			for (const { anchor } of tracked) {
				forest.anchors.forget(anchor);
			}
			snapshot?.roots.referenceRemoved();
			snapshot?.chunker.dispose();
			forest.roots.referenceRemoved();
			forest.chunker.dispose();
		},
	};
}

describe("visitDelta detached range benchmarks", () => {
	configureBenchmarkHooks();
	const sizes = currentBenchmarkMode === BenchmarkMode.Performance ? [1024, 65536] : [16];
	for (const size of sizes) {
		for (const count of [size / 2, size]) {
			for (const context of [
				"unanchored",
				"sparse anchors",
				"sparse anchors, shared",
			] as const) {
				for (const grouped of [false, true]) {
					const name = `${grouped ? "grouped" : "singleton"}, ${context}, document ${size}, span ${count}`;
					const setup = () => fixture(size, count, grouped, context);
					benchmarkIt({
						title: `detach: ${name}`,
						...benchmarkDurationBatchless({
							benchmarkFn: (state) => {
								let running: boolean;
								do {
									const value = setup();
									running = state.time(value.run);
									value.verify();
									value.dispose();
								} while (running);
							},
							minSampleCount: 30,
							maxBenchmarkDurationSeconds: 5,
						}),
					});
					benchmarkIt({
						title: `retained work counts: ${name}`,
						run: async () => {
							const value = setup();
							const detaches = value.measureWork();
							const { ranges, fields } = value.verify();
							assert.equal(detaches, grouped ? 1 : count);
							value.dispose();
							return [
								{
									name: "detach calls",
									value: detaches,
									units: "calls",
									type: ValueType.SmallerIsBetter,
									significance: "Primary",
								},
								{
									name: "retained index ranges",
									value: ranges,
									units: "ranges",
									type: ValueType.SmallerIsBetter,
								},
								{
									name: "forest fields including document",
									value: fields,
									units: "fields",
									type: ValueType.SmallerIsBetter,
								},
							] satisfies CollectedData;
						},
					});
					if (count === size && context === "unanchored") {
						benchmarkIt({
							title: `incremental retained forest and index heap: ${name}`,
							...benchmarkMemoryUse({
								...memoryAddedBy({
									setup,
									modify: (value) => value.run(),
									after: (value) => {
										value.verify();
										value.dispose();
									},
								}),
								warmUpIterations: 2,
								keepIterations: 6,
							}),
						});
					}
				}
			}
		}
	}
});
