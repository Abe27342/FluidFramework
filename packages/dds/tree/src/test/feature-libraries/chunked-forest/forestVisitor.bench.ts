/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import {
	BenchmarkMode,
	benchmarkDuration,
	benchmarkIt,
	currentBenchmarkMode,
} from "@fluid-tools/benchmark";

import {
	type DeltaVisitor,
	type FieldKey,
	TreeStoredSchemaRepository,
	aboveRootPlaceholder,
	rootFieldKey,
} from "../../../core/index.js";
// eslint-disable-next-line import-x/no-internal-modules
import { BasicChunk } from "../../../feature-libraries/chunked-forest/basicChunk.js";
// eslint-disable-next-line import-x/no-internal-modules
import { ChunkedForest } from "../../../feature-libraries/chunked-forest/chunkedForest.js";
import {
	defaultIncrementalEncodingPolicy,
	defaultSchemaPolicy,
	makeTreeChunker,
} from "../../../feature-libraries/index.js";
import { SchemaFactory, numberSchema, toInitialSchema } from "../../../simple-tree/index.js";
import { brand } from "../../../util/index.js";
import { configureBenchmarkHooks } from "../../utils.js";

describe("Forest visitor benchmarks", () => {
	configureBenchmarkHooks();
	const sf = new SchemaFactory("forest-visitor-benchmark");
	class Node extends sf.objectRecursive("Node", {
		child: sf.optionalRecursive([() => Node]),
		value: sf.number,
	}) {}
	const childKey: FieldKey = brand("child");
	const valueKey: FieldKey = brand("value");
	const detachedKey: FieldKey = brand("visitor-detached");
	const depths =
		currentBenchmarkMode === BenchmarkMode.Performance ? [8, 16, 32, 64, 128] : [8];

	for (const depth of depths) {
		for (const operation of ["walk", "detach and attach"] as const) {
			benchmarkIt({
				title: `${operation}, depth ${depth}`,
				...benchmarkDuration({
					maxBenchmarkDurationSeconds: 1,
					benchmarkFnCustom: async (state) => {
						let node: BasicChunk | undefined;
						for (let level = 0; level < depth; level++) {
							const value = new BasicChunk(brand(numberSchema.identifier), new Map(), 0);
							const fields = new Map<FieldKey, BasicChunk[]>([[valueKey, [value]]]);
							if (node !== undefined) {
								fields.set(childKey, [node]);
							}
							node = new BasicChunk(brand(Node.identifier), fields);
						}
						assert(node !== undefined);
						const schema = new TreeStoredSchemaRepository(toInitialSchema(Node));
						const forest = new ChunkedForest(
							new BasicChunk(aboveRootPlaceholder, new Map([[rootFieldKey, [node]]])),
							schema,
							makeTreeChunker(schema, defaultSchemaPolicy, defaultIncrementalEncodingPolicy),
						);
						const enter = (visitor: DeltaVisitor): void => {
							visitor.enterField(rootFieldKey);
							for (let level = 0; level < depth; level++) {
								visitor.enterNode(0);
								visitor.enterField(level + 1 < depth ? childKey : valueKey);
							}
						};
						if (operation === "walk") {
							state.timeAllBatches(() => {
								const visitor = forest.acquireVisitor();
								enter(visitor);
								for (let level = depth - 1; level >= 0; level--) {
									visitor.exitField(level + 1 === depth ? valueKey : childKey);
									visitor.exitNode(0);
								}
								visitor.exitField(rootFieldKey);
								visitor.free();
							});
						} else {
							const visitor = forest.acquireVisitor();
							enter(visitor);
							try {
								state.timeAllBatches(() => {
									visitor.detach({ start: 0, end: 1 }, detachedKey, { minor: 0 }, false);
									visitor.attach(detachedKey, 1, 0);
								});
							} finally {
								visitor.free();
							}
						}
						const cursor = forest.getCursorAboveDetachedFields();
						cursor.enterField(rootFieldKey);
						for (let level = 0; level < depth; level++) {
							cursor.enterNode(0);
							cursor.enterField(level + 1 < depth ? childKey : valueKey);
						}
						cursor.enterNode(0);
						assert.equal(cursor.value, 0);
					},
				}),
			});
		}
	}
});
