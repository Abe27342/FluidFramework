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

import type { FieldKey, TreeChunk, TreeNodeSchemaIdentifier } from "../../core/index.js";
// eslint-disable-next-line import-x/no-internal-modules
import { BasicChunk } from "../../feature-libraries/chunked-forest/basicChunk.js";
import {
	TreeShape,
	UniformChunk,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../feature-libraries/chunked-forest/uniformChunk.js";
import { ForestTypeOptimized, createIndependentTreeAlpha } from "../../shared-tree/index.js";
import { SchemaFactory, TreeViewConfiguration } from "../../simple-tree/index.js";
import { brand } from "../../util/index.js";
import { configureBenchmarkHooks } from "../utils.js";

const lengths =
	currentBenchmarkMode === BenchmarkMode.Performance ? [100, 1000, 10_000] : [100];

interface CharacterSequence extends Iterable<{ readonly content: string }> {
	readonly length: number;
	readonly [index: number]: { readonly content: string };
}

describe("Array indexing benchmarks", () => {
	configureBenchmarkHooks();

	describe("Chunk cursor", () => {
		const fieldKey = brand<FieldKey>("characters");
		const leafType = brand<TreeNodeSchemaIdentifier>("number");
		const shape = new TreeShape(leafType, true, []);

		for (const length of lengths) {
			for (const nodesPerChunk of [1, 25]) {
				for (const operation of [
					"length",
					"last index",
					"edit then last index",
					"indexed scan",
					"iterator scan",
				] as const) {
					benchmarkIt({
						title: `${operation}, ${length} nodes, ${
							nodesPerChunk === 1 ? "BasicChunks" : "UniformChunks of 25"
						}`,
						...benchmarkDuration({
							maxBenchmarkDurationSeconds: 1,
							benchmarkFnCustom: async (state) => {
								const chunks: TreeChunk[] = [];
								for (let start = 0; start < length; start += nodesPerChunk) {
									const values = Array.from(
										{ length: Math.min(nodesPerChunk, length - start) },
										(_, index) => start + index,
									);
									chunks.push(
										nodesPerChunk === 1
											? new BasicChunk(leafType, new Map(), start)
											: new UniformChunk(shape.withTopLevelLength(values.length), values),
									);
								}
								const root = new BasicChunk(brand("array"), new Map([[fieldKey, chunks]]));
								let cursor = root.cursor();
								assert(cursor.firstNode());
								cursor.enterField(fieldKey);
								assert.equal(cursor.getFieldLength(), length);
								let result: number | undefined;
								try {
									state.timeAllBatches(() => {
										if (operation === "length") {
											result = cursor.getFieldLength();
										} else if (
											operation === "last index" ||
											operation === "edit then last index"
										) {
											if (operation === "edit then last index") {
												const edit = root.acquireEditor();
												const field = root.acquireField(edit, fieldKey);
												try {
													const last = field.chunks.length - 1;
													const previous = field.chunks[last];
													assert(
														previous instanceof BasicChunk || previous instanceof UniformChunk,
													);
													for (const removed of field.splice(last, 1, [previous.clone()])) {
														removed.referenceRemoved();
													}
												} finally {
													field.close();
													edit.close();
												}
												cursor = root.cursor();
												assert(cursor.firstNode());
												cursor.enterField(fieldKey);
											}
											cursor.enterNode(length - 1);
											result = cursor.value as number;
											cursor.exitNode();
										} else {
											let sum = 0;
											if (operation === "indexed scan") {
												for (let index = 0; index < length; index++) {
													cursor.enterNode(index);
													sum += cursor.value as number;
													cursor.exitNode();
												}
											} else {
												if (cursor.firstNode()) {
													do {
														sum += cursor.value as number;
													} while (cursor.nextNode());
												}
											}
											result = sum;
										}
									});
									assert.equal(
										result,
										operation === "length"
											? length
											: operation === "last index" || operation === "edit then last index"
												? length - 1
												: (length * (length - 1)) / 2,
									);
								} finally {
									root.referenceRemoved();
								}
							},
						}),
					});
				}
			}
		}
	});

	describe("Character array binding", () => {
		const sf = new SchemaFactory("array-indexing-bench");
		class UniformCharacter extends sf.object("UniformCharacter", { content: sf.string }) {}
		// An optional field prevents the character subtree from having a schema-derived uniform shape.
		class BasicCharacter extends sf.object("BasicCharacter", {
			content: sf.string,
			format: sf.optional(sf.number),
		}) {}
		class UniformCharacters extends sf.array("UniformCharacters", UniformCharacter) {}
		class BasicCharacters extends sf.array("BasicCharacters", BasicCharacter) {}

		for (const length of lengths) {
			for (const representation of [
				"Native array",
				"Uniform characters",
				"Basic characters",
			]) {
				for (const operation of [
					"first index",
					"last index",
					"indexed scan",
					"iterator scan",
				]) {
					benchmarkIt({
						title: `${representation}, ${operation}, ${length} characters`,
						...benchmarkDuration({
							maxBenchmarkDurationSeconds: 1,
							benchmarkFnCustom: async (state) => {
								const data = Array.from({ length }, (_, index) => ({
									content: index % 2 === 0 ? "a" : "b",
								}));
								const tree = createIndependentTreeAlpha({ forest: ForestTypeOptimized });
								const view = tree.viewWith(
									new TreeViewConfiguration({
										schema: [UniformCharacters, BasicCharacters],
									}),
								);
								let characters: CharacterSequence;
								if (representation === "Native array") {
									characters = data;
								} else {
									view.initialize(
										representation === "Uniform characters"
											? new UniformCharacters(data)
											: new BasicCharacters(data),
									);
									characters = view.root;
								}
								try {
									// Exclude first-time wrapper creation and length-cache activation from timing.
									let expectedSum = 0;
									for (const character of characters) {
										expectedSum += character.content.length;
									}
									const count = characters.length;
									assert.equal(count, length);
									assert.equal(expectedSum, length);
									let result = 0;
									state.timeAllBatches(() => {
										if (operation === "first index") {
											result = characters[0].content.length;
										} else if (operation === "last index") {
											result = characters[count - 1].content.length;
										} else {
											let sum = 0;
											if (operation === "indexed scan") {
												// Cache length so this isolates indexing, not loop-condition length reads.
												for (let index = 0; index < count; index++) {
													sum += characters[index].content.length;
												}
											} else {
												for (const character of characters) {
													sum += character.content.length;
												}
											}
											result = sum;
										}
									});
									assert.equal(
										result,
										operation === "first index"
											? 1
											: operation === "last index"
												? data[count - 1].content.length
												: expectedSum,
									);
								} finally {
									view.dispose();
								}
							},
						}),
					});
				}
			}
		}
	});
});
