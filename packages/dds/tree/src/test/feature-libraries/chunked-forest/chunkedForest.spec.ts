/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { validateAssertionError } from "@fluidframework/test-runtime-utils/internal";

import {
	type FieldKey,
	type TreeChunk,
	type TreeNodeSchemaIdentifier,
	type TreeStoredSchema,
	type TreeStoredSchemaSubscription,
	TreeStoredSchemaRepository,
	aboveRootPlaceholder,
	createAnnouncedVisitor,
	rootFieldKey,
} from "../../../core/index.js";
import {
	Chunker,
	type ChunkCompressor,
	type IChunker,
	type ShapeInfo,
	defaultChunkPolicy,
	coalesceUniformChunks,
	makeTreeChunker,
	polymorphic,
	splitFieldAtIndex,
	tryShapeFromNodeSchema,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../feature-libraries/chunked-forest/chunkTree.js";
import {
	BasicChunk,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../feature-libraries/chunked-forest/basicChunk.js";
import {
	ChunkSequence,
	ChunkEdit,
	ChunkSequenceEditor,
	type MutableChunk,
	chunkIndexThreshold,
	getChunkIndex,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../feature-libraries/chunked-forest/chunkSequence.js";
/* eslint-disable import-x/no-internal-modules -- Import implementation helpers for direct tests. */
import {
	buildChunkedForest,
	ChunkedForest,
	ensureExclusiveBasicChunk,
	locateNodeInChunks,
} from "../../../feature-libraries/chunked-forest/chunkedForest.js";
/* eslint-enable import-x/no-internal-modules -- End direct implementation imports. */
// eslint-disable-next-line import-x/no-internal-modules
import { SequenceChunk } from "../../../feature-libraries/chunked-forest/sequenceChunk.js";
import {
	TreeShape,
	UniformChunk,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../feature-libraries/chunked-forest/uniformChunk.js";
import {
	defaultIncrementalEncodingPolicy,
	defaultSchemaPolicy,
} from "../../../feature-libraries/index.js";
import { SchemaFactory, numberSchema, toInitialSchema } from "../../../simple-tree/index.js";
import { brand, makeArray } from "../../../util/index.js";
import { testForest } from "../../forestTestSuite.js";

const chunkers: [string, (schema: TreeStoredSchemaSubscription) => IChunker][] = [
	[
		"basic",
		(schema): IChunker =>
			new Chunker(
				schema,
				defaultSchemaPolicy,
				Number.POSITIVE_INFINITY,
				Number.POSITIVE_INFINITY,
				0,
				defaultChunkPolicy.uniformChunkNodeCountDynamicTargetMax,
				() => polymorphic,
			),
	],
	[
		"default",
		(schema) => makeTreeChunker(schema, defaultSchemaPolicy, defaultIncrementalEncodingPolicy),
	],
	[
		"sequences",
		(schema): IChunker =>
			new Chunker(schema, defaultSchemaPolicy, 2, 1, 0, 0, (): ShapeInfo => polymorphic),
	],
	[
		"minimal-uniform",
		(schema): IChunker =>
			new Chunker(
				schema,
				defaultSchemaPolicy,
				Number.POSITIVE_INFINITY,
				Number.POSITIVE_INFINITY,
				1,
				0,
				(
					type: TreeNodeSchemaIdentifier,
					shapes: Map<TreeNodeSchemaIdentifier, ShapeInfo>,
					chunkerSchema: TreeStoredSchema,
				) =>
					tryShapeFromNodeSchema(
						{
							schema: chunkerSchema,
							policy: defaultSchemaPolicy,
							shouldEncodeIncrementally: defaultIncrementalEncodingPolicy,
							shapes,
						},
						type,
					),
			),
	],
	[
		"uniform",
		(schema): IChunker =>
			new Chunker(
				schema,
				defaultSchemaPolicy,
				Number.POSITIVE_INFINITY,
				Number.POSITIVE_INFINITY,
				defaultChunkPolicy.uniformChunkNodeCount,
				defaultChunkPolicy.uniformChunkNodeCountDynamicTargetMax,
				(
					type: TreeNodeSchemaIdentifier,
					shapes: Map<TreeNodeSchemaIdentifier, ShapeInfo>,
					chunkerSchema: TreeStoredSchema,
				) =>
					tryShapeFromNodeSchema(
						{
							schema: chunkerSchema,
							policy: defaultSchemaPolicy,
							shouldEncodeIncrementally: defaultIncrementalEncodingPolicy,
							shapes,
						},
						type,
					),
			),
	],
	[
		"mixed",
		(schema): IChunker =>
			new Chunker(
				schema,
				defaultSchemaPolicy,
				2,
				1,
				defaultChunkPolicy.uniformChunkNodeCount,
				defaultChunkPolicy.uniformChunkNodeCountDynamicTargetMax,
				(
					type: TreeNodeSchemaIdentifier,
					shapes: Map<TreeNodeSchemaIdentifier, ShapeInfo>,
					chunkerSchema: TreeStoredSchema,
				) =>
					tryShapeFromNodeSchema(
						{
							schema: chunkerSchema,
							policy: defaultSchemaPolicy,
							shouldEncodeIncrementally: defaultIncrementalEncodingPolicy,
							shapes,
						},
						type,
					),
			),
	],
];

describe("Chunker", () => {
	class TestSchema extends TreeStoredSchemaRepository {
		public hasAfterSchemaChangeListeners(): boolean {
			return this._events.hasListeners("afterSchemaChange");
		}
	}

	it("maintains one schema listener for the current cache contents", () => {
		const schema = new TestSchema();
		let shapeComputations = 0;
		const chunker = new Chunker(
			schema,
			defaultSchemaPolicy,
			Number.POSITIVE_INFINITY,
			Number.POSITIVE_INFINITY,
			0,
			0,
			() => {
				shapeComputations += 1;
				return polymorphic;
			},
		);
		const firstType = brand<TreeNodeSchemaIdentifier>("first");
		const secondType = brand<TreeNodeSchemaIdentifier>("second");

		chunker.shapeFromSchema(firstType);
		chunker.shapeFromSchema(firstType);
		assert.equal(shapeComputations, 1);
		chunker.shapeFromSchema(secondType);
		assert.equal(shapeComputations, 2);
		assert.equal(schema.hasAfterSchemaChangeListeners(), true);

		schema.apply(schema);
		assert.equal(schema.hasAfterSchemaChangeListeners(), false);

		chunker.shapeFromSchema(firstType);
		assert.equal(shapeComputations, 3);
		assert.equal(schema.hasAfterSchemaChangeListeners(), true);
		chunker.dispose();
		assert.equal(schema.hasAfterSchemaChangeListeners(), false);
	});
});

describe("ChunkedForest", () => {
	for (const [name, chunker] of chunkers) {
		describe(name, () => {
			testForest({
				factory: (schema) => buildChunkedForest(chunker(schema)),
				skipCursorErrorCheck: true,
			});
		});
	}

	/** Shape used to construct the uniform chunks in these tests. */
	const numberShape = new TreeShape(
		brand<TreeNodeSchemaIdentifier>(numberSchema.identifier),
		true,
		[],
	);

	function forestWithFields(
		chunker: IChunker,
		fields: ReadonlyMap<FieldKey, readonly TreeChunk[]>,
	) {
		return new ChunkedForest(
			new BasicChunk(aboveRootPlaceholder, fields),
			chunker.schema,
			chunker,
		);
	}

	function createField(forest: ChunkedForest, key: FieldKey, chunk: TreeChunk): void {
		const cursor = chunk.cursor();
		assert(cursor.firstNode());
		const visitor = forest.acquireVisitor();
		visitor.create([cursor], key);
		visitor.free();
		chunk.referenceRemoved();
	}

	describe("field index invalidation", () => {
		const detachedKey: FieldKey = brand("indexed-detached");

		function setupForest(chunks: TreeChunk[]) {
			const schema = new TreeStoredSchemaRepository(toInitialSchema(SchemaFactory.number));
			return forestWithFields(
				makeTreeChunker(schema, defaultSchemaPolicy, defaultIncrementalEncodingPolicy),
				new Map([[rootFieldKey, chunks]]),
			);
		}

		function checkField(
			forest: ReturnType<typeof setupForest>,
			key: FieldKey,
			expected: readonly number[],
		): void {
			const cursor = forest.allocateCursor();
			try {
				forest.tryMoveCursorToField({ parent: undefined, fieldKey: key }, cursor);
				assert.equal(cursor.getFieldLength(), expected.length);
				for (let index = expected.length - 1; index >= 0; index--) {
					cursor.enterNode(index);
					assert.equal(cursor.value, expected[index]);
					assert.equal(cursor.fieldIndex, index);
					cursor.exitNode();
				}
			} finally {
				cursor.free();
			}
		}

		it("rebuilds after attach, detach, and moves across the indexing threshold", () => {
			const expected = Array.from({ length: chunkIndexThreshold - 1 }, (_, index) => index);
			const input = expected.map(
				(value) => new BasicChunk(numberShape.type, new Map(), value),
			);
			const forest = setupForest(input);
			const chunks = forest.roots.fields.get(rootFieldKey) ?? assert.fail();
			checkField(forest, rootFieldKey, expected);
			assert.equal(getChunkIndex(chunks), undefined);
			createField(forest, detachedKey, new BasicChunk(numberShape.type, new Map(), -1));

			const attach = (index: number): void => {
				const attachVisitor = forest.acquireVisitor();
				attachVisitor.enterField(rootFieldKey);
				attachVisitor.attach(detachedKey, 1, index);
				attachVisitor.exitField(rootFieldKey);
				attachVisitor.free();
				expected.splice(index, 0, -1);
				checkField(forest, rootFieldKey, expected);
			};
			attach(32);
			assert.notEqual(getChunkIndex(chunks), undefined);

			const visitor = forest.acquireVisitor();
			visitor.enterField(rootFieldKey);
			visitor.detach({ start: 32, end: 33 }, detachedKey, { minor: 0 }, false);
			visitor.exitField(rootFieldKey);
			visitor.free();
			expected.splice(32, 1);
			checkField(forest, rootFieldKey, expected);
			checkField(forest, detachedKey, [-1]);
			assert.equal(getChunkIndex(chunks), undefined);
			attach(0);
		});

		it("rebuilds after expanding a chunk without changing the node count", () => {
			const chunks = Array.from(
				{ length: chunkIndexThreshold },
				(_, index) =>
					new UniformChunk(numberShape.withTopLevelLength(2), [index * 2, index * 2 + 1]),
			);
			const forest = setupForest(chunks);
			const expected = Array.from({ length: chunks.length * 2 }, (_, index) => index);
			checkField(forest, rootFieldKey, expected);

			const visitor = forest.acquireVisitor();
			visitor.enterField(rootFieldKey);
			visitor.enterNode(3);
			visitor.exitNode(3);
			visitor.exitField(rootFieldKey);
			visitor.free();

			assert.equal(forest.roots.fields.get(rootFieldKey)?.length, chunkIndexThreshold + 1);
			checkField(forest, rootFieldKey, expected);
		});

		it("rebuilds after splitting or coalescing chunk boundaries", () => {
			const chunks = Array.from(
				{ length: chunkIndexThreshold + 1 },
				(_, index) =>
					new UniformChunk(numberShape.withTopLevelLength(2), [index * 2, index * 2 + 1]),
			);
			const sequence = new ChunkSequence(chunks);
			const expected = Array.from({ length: chunks.length * 2 }, (_, index) => index);
			const schema = new TreeStoredSchemaRepository(toInitialSchema(SchemaFactory.number));
			const chunker = makeTreeChunker(
				schema,
				defaultSchemaPolicy,
				defaultIncrementalEncodingPolicy,
			);
			const initialIndex = sequence.getIndex();
			sequence.edit((editor) =>
				splitFieldAtIndex(editor, 1, { policy: chunker, idCompressor: undefined }),
			);
			const splitIndex = sequence.getIndex();
			assert.notEqual(splitIndex, initialIndex);

			sequence.edit((editor) => coalesceUniformChunks(editor, chunker, { start: 0, end: 3 }));
			assert.equal(sequence.chunks.length, chunkIndexThreshold);
			assert.equal(sequence.length, expected.length);
			assert.notEqual(sequence.getIndex(), splitIndex);
			sequence.dispose();
		});

		it("keeps a cloned forest's index independent of mutations", () => {
			const expected = Array.from({ length: chunkIndexThreshold }, (_, index) => index);
			const forest = setupForest(
				expected.map((value) => new BasicChunk(numberShape.type, new Map(), value)),
			);
			checkField(forest, rootFieldKey, expected);
			const clone = forest.clone(forest.schema);
			checkField(clone, rootFieldKey, expected);

			const visitor = clone.acquireVisitor();
			visitor.enterField(rootFieldKey);
			visitor.detach({ start: 0, end: 1 }, detachedKey, { minor: 0 }, false);
			visitor.exitField(rootFieldKey);
			visitor.free();
			checkField(clone, rootFieldKey, expected.slice(1));
			checkField(clone, detachedKey, [0]);
			checkField(forest, rootFieldKey, expected);
		});

		it("supports reads between operations on an acquired visitor", () => {
			const expected = Array.from({ length: chunkIndexThreshold }, (_, index) => index);
			const forest = setupForest(
				expected.map((value) => new BasicChunk(numberShape.type, new Map(), value)),
			);
			const visitor = forest.acquireVisitor();
			visitor.enterField(rootFieldKey);
			checkField(forest, rootFieldKey, expected);
			visitor.detach({ start: 0, end: 1 }, detachedKey, { minor: 0 }, false);
			checkField(forest, rootFieldKey, expected.slice(1));
			visitor.attach(detachedKey, 1, 0);
			checkField(forest, rootFieldKey, expected);
			visitor.exitField(rootFieldKey);
			visitor.free();
		});

		it("rejects cloning until the acquired visitor is freed", () => {
			const forest = setupForest([new BasicChunk(numberShape.type, new Map(), 0)]);
			const visitor = forest.acquireVisitor();
			visitor.enterField(rootFieldKey);
			visitor.enterNode(0);
			assert.throws(
				() => forest.clone(forest.schema),
				validateAssertionError("Cannot clone a forest with an acquired visitor"),
			);
			visitor.free();
			const clone = forest.clone(forest.schema);
			checkField(clone, rootFieldKey, [0]);
			const next = forest.acquireVisitor();
			next.free();
		});

		it("supports announced reads after mutations while retaining the path", () => {
			const values = Array.from({ length: chunkIndexThreshold }, (_, index) => index);
			const forest = setupForest(
				values.map((value) => new BasicChunk(numberShape.type, new Map(), value)),
			);
			let expected: readonly number[] = values;
			let reads = 0;
			const read = (): void => {
				checkField(forest, rootFieldKey, expected);
				reads++;
			};
			forest.registerAnnouncedVisitor(() =>
				createAnnouncedVisitor({ afterAttach: read, afterDetach: read }),
			);
			const visitor = forest.acquireVisitor();
			visitor.enterField(rootFieldKey);
			expected = values.slice(1);
			visitor.detach({ start: 0, end: 1 }, detachedKey, { minor: 0 }, false);
			expected = values;
			visitor.attach(detachedKey, 1, 0);
			visitor.free();
			assert.equal(reads, 2);
		});

		it("walks pre-cloned forests independently with both visitors acquired", () => {
			const values = Array.from({ length: chunkIndexThreshold }, (_, index) => index);
			const forest = setupForest(
				values.map((value) => new BasicChunk(numberShape.type, new Map(), value)),
			);
			const clone = forest.clone(forest.schema);
			const first = forest.acquireVisitor();
			const second = clone.acquireVisitor();
			first.enterField(rootFieldKey);
			second.enterField(rootFieldKey);
			first.enterNode(0);
			second.enterNode(0);
			first.exitNode(0);
			first.detach({ start: 0, end: 1 }, detachedKey, { minor: 0 }, false);
			checkField(clone, rootFieldKey, values);
			second.exitNode(0);
			second.detach(
				{ start: values.length - 1, end: values.length },
				detachedKey,
				{ minor: 0 },
				false,
			);
			checkField(forest, rootFieldKey, values.slice(1));
			checkField(clone, rootFieldKey, values.slice(0, -1));
			first.free();
			second.free();
		});

		for (const atNode of [false, true]) {
			it(`releases an unfinished traversal in ${atNode ? "node" : "field"} mode`, () => {
				const forest = setupForest([new BasicChunk(numberShape.type, new Map(), 0)]);
				const visitor = forest.acquireVisitor();
				visitor.enterField(rootFieldKey);
				visitor.enterNode(0);
				if (!atNode) {
					visitor.enterField(brand("absent"));
				}
				visitor.free();
				const clone = forest.clone(forest.schema);
				checkField(clone, rootFieldKey, [0]);
				const next = forest.acquireVisitor();
				next.free();
			});
		}
	});

	it("performs only linear capability validation during a deep traversal", () => {
		const sf = new SchemaFactory("visitor-depth");
		class Node extends sf.objectRecursive("Node", {
			child: sf.optionalRecursive([() => Node]),
		}) {}
		const childKey: FieldKey = brand("child");
		const countChecks = (depth: number): number => {
			let chunk = new BasicChunk(brand(Node.identifier), new Map());
			for (let level = 1; level < depth; level++) {
				chunk = new BasicChunk(brand(Node.identifier), new Map([[childKey, [chunk]]]));
			}
			const schema = new TreeStoredSchemaRepository(toInitialSchema(Node));
			const forest = forestWithFields(
				makeTreeChunker(schema, defaultSchemaPolicy, defaultIncrementalEncodingPolicy),
				new Map([[rootFieldKey, [chunk]]]),
			);
			const assertFor = ChunkEdit.prototype.assertFor;
			const assertActive = ChunkSequenceEditor.prototype.assertActive;
			let checks = 0;
			ChunkEdit.prototype.assertFor = function (this: ChunkEdit, node: MutableChunk): void {
				checks++;
				assertFor.call(this, node);
			};
			ChunkSequenceEditor.prototype.assertActive = function (this: ChunkSequenceEditor): void {
				checks++;
				assertActive.call(this);
			};
			try {
				const visitor = forest.acquireVisitor();
				visitor.enterField(rootFieldKey);
				for (let level = 0; level < depth; level++) {
					visitor.enterNode(0);
					if (level + 1 < depth) {
						visitor.enterField(childKey);
					}
				}
				for (let level = depth - 1; level >= 0; level--) {
					visitor.exitNode(0);
					visitor.exitField(level === 0 ? rootFieldKey : childKey);
				}
				visitor.free();
			} finally {
				ChunkEdit.prototype.assertFor = assertFor;
				ChunkSequenceEditor.prototype.assertActive = assertActive;
			}
			assert(checks < depth * 64);
			return checks;
		};
		const small = countChecks(32);
		const medium = countChecks(64);
		const large = countChecks(128);
		assert.equal(large - medium, 2 * (medium - small));
	});

	describe("locateNodeInChunks", () => {
		it("uses an owned index while the field editor is acquired", () => {
			let lengthReads = 0;
			class CountingChunk extends UniformChunk {
				public override get topLevelLength(): number {
					lengthReads++;
					return super.topLevelLength;
				}
			}
			const chunks = Array.from(
				{ length: chunkIndexThreshold },
				(_, index) => new CountingChunk(numberShape.withTopLevelLength(1), [index]),
			);
			const sequence = new ChunkSequence(chunks);
			const cachedIndex = sequence.getIndex();
			lengthReads = 0;
			sequence.edit((editor) => {
				assert.equal(locateNodeInChunks(editor, chunks.length - 1).chunk, chunks.at(-1));
				assert.equal(sequence.getIndex(), cachedIndex);
				assert.equal(lengthReads, 0);
			});
			sequence.dispose();
		});

		it("locates nodes by chunk index and offset", () => {
			const first = new BasicChunk(numberShape.type, new Map(), 0);
			const middle = new UniformChunk(numberShape.withTopLevelLength(3), [1, 2, 3]);
			const last = new BasicChunk(numberShape.type, new Map(), 4);
			const chunks = [first, middle, last];

			assert.deepEqual(locateNodeInChunks(chunks, 0), {
				chunk: first,
				indexOfChunk: 0,
				indexWithinChunk: 0,
			});
			assert.deepEqual(locateNodeInChunks(chunks, 1), {
				chunk: middle,
				indexOfChunk: 1,
				indexWithinChunk: 0,
			});
			assert.deepEqual(locateNodeInChunks(chunks, 3), {
				chunk: middle,
				indexOfChunk: 1,
				indexWithinChunk: 2,
			});
			assert.deepEqual(locateNodeInChunks(chunks, 4), {
				chunk: last,
				indexOfChunk: 2,
				indexWithinChunk: 0,
			});
		});

		it("rejects invalid node indices", () => {
			const chunks = [new BasicChunk(numberShape.type, new Map(), 0)];

			assert.throws(
				() => locateNodeInChunks(chunks, -1),
				validateAssertionError("index must be non-negative"),
			);
			for (const index of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
				assert.throws(
					() => locateNodeInChunks(chunks, index),
					validateAssertionError("index must be an integer"),
				);
			}
			assert.throws(
				() => locateNodeInChunks(chunks, 1),
				validateAssertionError("missing edited node"),
			);
			assert.throws(
				() => locateNodeInChunks([], 0),
				validateAssertionError("Array index is out of bounds"),
			);
		});
	});

	describe("ensureExclusiveBasicChunk", () => {
		function makeCompressor(): ChunkCompressor {
			const schema = new TreeStoredSchemaRepository(toInitialSchema(SchemaFactory.number));
			return {
				policy: makeTreeChunker(schema, defaultSchemaPolicy, defaultIncrementalEncodingPolicy),
				idCompressor: undefined,
			};
		}

		function valuesFromChunks(chunks: readonly TreeChunk[]): unknown[] {
			const values: unknown[] = [];
			for (const chunk of chunks) {
				const cursor = chunk.cursor();
				for (let hasNode = cursor.firstNode(); hasNode; hasNode = cursor.nextNode()) {
					values.push(cursor.value);
				}
			}
			return values;
		}

		it("returns an exclusively owned BasicChunk unchanged", () => {
			const basic = new BasicChunk(numberShape.type, new Map(), 0);
			const chunks: TreeChunk[] = [basic];

			const { chunk: result } = ensureExclusiveBasicChunk(chunks, 0, makeCompressor());

			assert.equal(result, basic);
			assert.equal(chunks[0], basic);
			assert.equal(result.isShared(), false);
		});

		it("rejects an invalid index without modifying the chunks", () => {
			const uniform = new UniformChunk(numberShape.withTopLevelLength(2), [0, 1]);
			const chunks: TreeChunk[] = [uniform];

			assert.throws(
				() => ensureExclusiveBasicChunk(chunks, 2, makeCompressor()),
				validateAssertionError("missing edited node"),
			);

			assert.deepEqual(chunks, [uniform]);
			assert.equal(uniform.isUnreferenced(), false);
		});

		it("clones a shared BasicChunk and releases the array's old reference", () => {
			const basic = new BasicChunk(numberShape.type, new Map(), 0);
			basic.referenceAdded();
			const chunks: TreeChunk[] = [basic];

			const { chunk: result } = ensureExclusiveBasicChunk(chunks, 0, makeCompressor());

			assert.notEqual(result, basic);
			assert.equal(chunks[0], result);
			assert.equal(result.isShared(), false);
			assert.equal(basic.isShared(), false);
		});

		it("normalizes a UniformChunk and selects the requested node", () => {
			const uniform = new UniformChunk(numberShape.withTopLevelLength(3), [0, 1, 2]);
			const chunks: TreeChunk[] = [uniform];

			const { chunk: result } = ensureExclusiveBasicChunk(chunks, 2, makeCompressor());

			assert.equal(result, chunks[2]);
			assert.equal(result.value, 2);
			assert.equal(result.isShared(), false);
			assert.equal(uniform.isUnreferenced(), true);
			assert.deepEqual(valuesFromChunks(chunks), [0, 1, 2]);
		});

		it("selects the requested node when the containing chunk and node offsets are nonzero", () => {
			const leading = new BasicChunk(numberShape.type, new Map(), -1);
			const uniform = new UniformChunk(numberShape.withTopLevelLength(3), [0, 1, 2]);
			const trailing = new BasicChunk(numberShape.type, new Map(), 3);
			const chunks: TreeChunk[] = [leading, uniform, trailing];

			const { chunk: result } = ensureExclusiveBasicChunk(chunks, 3, makeCompressor());

			assert.equal(result, chunks[3]);
			assert.equal(result.value, 2);
			assert.equal(chunks[0], leading);
			assert.equal(chunks[4], trailing);
			assert.equal(uniform.isUnreferenced(), true);
			assert.deepEqual(valuesFromChunks(chunks), [-1, 0, 1, 2, 3]);
		});

		it("normalizes a shared SequenceChunk without replacing a sibling", () => {
			const sequence = new SequenceChunk([
				new BasicChunk(numberShape.type, new Map(), 0),
				new BasicChunk(numberShape.type, new Map(), 1),
				new BasicChunk(numberShape.type, new Map(), 2),
			]);
			sequence.referenceAdded();
			const chunks: TreeChunk[] = [sequence];

			const { chunk: result } = ensureExclusiveBasicChunk(chunks, 2, makeCompressor());

			assert.equal(result, chunks[2]);
			assert.equal(result.value, 2);
			assert.equal(result.isShared(), false);
			assert.deepEqual(valuesFromChunks(chunks), [0, 1, 2]);
		});
	});

	describe("mutation of chunks array inside a multi-node chunkShape", () => {
		/** Field key for the detached field used as the source/destination of attach/detach ops. */
		const detachedKey: FieldKey = brand("detached");

		/** Detached field id paired with `detachedKey`. */
		const detachedId = { minor: 0 };

		/**
		 * Builds a fresh chunked forest for use in a single test case.
		 *
		 * @returns A chunked forest with a root field containing a single uniform chunk of 5 numbers.
		 */
		function setupForest() {
			const forestSchema = new TreeStoredSchemaRepository(
				toInitialSchema(SchemaFactory.number),
			);
			const chunker = makeTreeChunker(
				forestSchema,
				defaultSchemaPolicy,
				defaultIncrementalEncodingPolicy,
			);
			const uniform = new UniformChunk(numberShape.withTopLevelLength(5), [0, 1, 2, 3, 4]);
			return forestWithFields(chunker, new Map([[rootFieldKey, [uniform]]]));
		}

		/**
		 * Sums the top-level lengths of the given chunks.
		 *
		 * @param chunks - The chunks to sum.
		 * @returns The total number of top-level nodes across the given `chunks`.
		 */
		function nodeCount(chunks: readonly TreeChunk[]): number {
			return chunks.reduce((runningTotal, chunk) => runningTotal + chunk.topLevelLength, 0);
		}

		it("detaches a single node from the middle of a uniform chunk", () => {
			const forest = setupForest();

			const visitor = forest.acquireVisitor();
			visitor.enterField(rootFieldKey);
			visitor.detach({ start: 2, end: 3 }, detachedKey, detachedId, false);
			visitor.exitField(rootFieldKey);
			visitor.free();

			const detached = forest.roots.fields.get(detachedKey);
			assert(detached !== undefined);
			assert.equal(detached.length, 1);
			const cursor = detached[0].cursor();
			cursor.firstNode();
			assert.equal(cursor.value, 2);

			const remaining = forest.roots.fields.get(rootFieldKey);
			assert(remaining !== undefined);
			assert.equal(nodeCount(remaining), 4);
		});

		it("enterNode resolves the correct chunk in a field with multiple multi-node chunks", () => {
			const forestSchema = new TreeStoredSchemaRepository(
				toInitialSchema(SchemaFactory.number),
			);
			const chunker = makeTreeChunker(
				forestSchema,
				defaultSchemaPolicy,
				defaultIncrementalEncodingPolicy,
			);
			const forest = forestWithFields(
				chunker,
				new Map([
					[
						rootFieldKey,
						[
							new UniformChunk(numberShape.withTopLevelLength(2), [0, 1]),
							new UniformChunk(numberShape.withTopLevelLength(5), [2, 3, 4, 5, 6]),
							new UniformChunk(numberShape.withTopLevelLength(3), [7, 8, 9]),
						],
					],
				]),
			);

			const visitor = forest.acquireVisitor();
			visitor.enterField(rootFieldKey);
			visitor.enterNode(6);
			visitor.exitNode(6);
			visitor.exitField(rootFieldKey);
			visitor.free();

			// enterNode shatters the targeted UniformChunk (with top-level length 5) into 5 BasicChunks; the
			// field's chunk count grows from 3 to 7, with the two flanking UniformChunks
			// untouched.
			const result = forest.roots.fields.get(rootFieldKey);
			assert(result !== undefined);
			assert.equal(result.length, 7);
			assert(result[0] instanceof UniformChunk);
			assert.equal(result[0].topLevelLength, 2);
			assert(result[6] instanceof UniformChunk);
			assert.equal(result[6].topLevelLength, 3);
		});

		it("enterNode preserves siblings when expanding a shared SequenceChunk", () => {
			const forestSchema = new TreeStoredSchemaRepository(
				toInitialSchema(SchemaFactory.number),
			);
			const forest = forestWithFields(
				makeTreeChunker(forestSchema, defaultSchemaPolicy, defaultIncrementalEncodingPolicy),
				new Map([
					[
						rootFieldKey,
						[
							new SequenceChunk([
								new BasicChunk(numberShape.type, new Map(), 0),
								new BasicChunk(numberShape.type, new Map(), 1),
								new BasicChunk(numberShape.type, new Map(), 2),
							]),
						],
					],
				]),
			);
			// Cloning shares the root and its descendants, forcing enterNode's copy-on-write path.
			const clone = forest.clone(forestSchema);

			const visitor = clone.acquireVisitor();
			visitor.enterField(rootFieldKey);
			visitor.enterNode(2);
			visitor.exitNode(2);
			visitor.exitField(rootFieldKey);
			visitor.free();

			const result = clone.roots.fields.get(rootFieldKey);
			assert(result !== undefined);
			assert.deepEqual(
				result.map((chunk) => {
					const cursor = chunk.cursor();
					assert(cursor.firstNode());
					return cursor.value;
				}),
				[0, 1, 2],
			);
		});

		it("attaches a single node into the middle of a uniform chunk", () => {
			const forest = setupForest();

			// Stage a source chunk in the detached field to be attached into the middle of root.
			const source = new UniformChunk(numberShape.withTopLevelLength(1), [99]);
			createField(forest, detachedKey, source);

			const visitor = forest.acquireVisitor();
			visitor.enterField(rootFieldKey);
			visitor.attach(detachedKey, 1, 2);
			visitor.exitField(rootFieldKey);
			visitor.free();

			// The source detached field should be consumed.
			assert.equal(forest.roots.fields.get(detachedKey), undefined);

			// The root field should now hold 6 nodes, with 99 landing at index 2.
			const updated = forest.roots.fields.get(rootFieldKey);
			assert(updated !== undefined);
			assert.equal(nodeCount(updated), 6);

			const values: unknown[] = [];
			for (const chunk of updated) {
				const cursor = chunk.cursor();
				for (let hasNode = cursor.firstNode(); hasNode; hasNode = cursor.nextNode()) {
					values.push(cursor.value);
				}
			}
			assert.deepEqual(values, [0, 1, 99, 2, 3, 4]);
		});

		/**
		 * Seeds the forest's root field with a sequence of single-shape UniformChunks of the given sizes.
		 *
		 * @remarks
		 * Lets tests position attach/detach boundaries on existing chunk seams and exercise
		 * `coalesceUniformChunks` without `splitFieldAtIndex` having to bisect first.
		 */
		function setupForestWithChunks(
			chunkSizes: readonly number[],
		): ReturnType<typeof setupForest> {
			const forestSchema = new TreeStoredSchemaRepository(
				toInitialSchema(SchemaFactory.number),
			);
			const chunker = makeTreeChunker(
				forestSchema,
				defaultSchemaPolicy,
				defaultIncrementalEncodingPolicy,
			);
			let nextValue = 0;
			const chunks: TreeChunk[] = chunkSizes.map(
				(size) =>
					new UniformChunk(
						numberShape.withTopLevelLength(size),
						makeArray(size, () => nextValue++),
					),
			);
			return forestWithFields(chunker, new Map([[rootFieldKey, chunks]]));
		}

		it("coalesces same-shape neighbors left adjacent by an aligned detach", () => {
			// Field pre-arranged as three same-shape UniformChunks of sizes 2, 1, 2 so the
			// detach lands on existing chunk boundaries — splitFieldAtIndex is a no-op and
			// only coalesceUniformChunks is exercised. After removing the middle single-node
			// chunk, the two 2-node chunks merge into a single 4-node chunk.
			const forest = setupForestWithChunks([2, 1, 2]);

			const visitor = forest.acquireVisitor();
			visitor.enterField(rootFieldKey);
			visitor.detach({ start: 2, end: 3 }, detachedKey, detachedId, false);
			visitor.exitField(rootFieldKey);
			visitor.free();

			const remaining = forest.roots.fields.get(rootFieldKey);
			assert(remaining !== undefined);
			assert.equal(remaining.length, 1);
			assert(remaining[0] instanceof UniformChunk);
			assert.equal(remaining[0].topLevelLength, 4);
		});

		it("enterNode resolves the correct chunk in a field with multiple multi-node chunks", () => {
			// Regression test for a chunk-walk bug in enterNode. Previously, the loop that
			// walks chunks to find the target index read its `chunk` variable at the top of
			// the loop body — before `indexOfChunk++` — so the next iteration's condition
			// check used the prior iteration's chunk. With fields containing multiple
			// multi-node UniformChunks (as produced by coalesceUniformChunks in steady state),
			// this caused the loop to overshoot the target chunk.
			//
			// Setup: three same-shape UniformChunks of sizes 2, 5, 3 — 10 total nodes.
			// enterNode(6) targets the 5-node chunk at local position 4 (global indices 2..6
			// land in that chunk). Pre-fix, the loop steps past the 5-node chunk and lands on
			// the 3-node chunk with indexWithinChunk = -1, throwing "Array index is out of
			// bounds" when dereferencing newChunks[-1].
			const forest = setupForestWithChunks([2, 5, 3]);

			const visitor = forest.acquireVisitor();
			visitor.enterField(rootFieldKey);
			visitor.enterNode(6);
			visitor.exitNode(6);
			visitor.exitField(rootFieldKey);
			visitor.free();

			// enterNode shatters the targeted 5-node UniformChunk into 5 BasicChunks; the
			// field's chunk count grows from 3 to 7, with the two flanking UniformChunks
			// left untouched.
			const result = forest.roots.fields.get(rootFieldKey);
			assert(result !== undefined);
			assert.equal(result.length, 7);
			assert(result[0] instanceof UniformChunk);
			assert.equal(result[0].topLevelLength, 2);
			assert(result[6] instanceof UniformChunk);
			assert.equal(result[6].topLevelLength, 3);
		});

		it("coalesces an inserted same-shape chunk with its neighbors", () => {
			// Field pre-arranged as two same-shape 2-node UniformChunks so the attach lands
			// on the existing seam — splitFieldAtIndex is a no-op. After inserting a
			// single-node UniformChunk with value 99 at index 2, coalesce merges both seams
			// into a single 5-node UniformChunk.
			const forest = setupForestWithChunks([2, 2]);
			const source = new UniformChunk(numberShape.withTopLevelLength(1), [99]);
			createField(forest, detachedKey, source);

			const visitor = forest.acquireVisitor();
			visitor.enterField(rootFieldKey);
			visitor.attach(detachedKey, 1, 2);
			visitor.exitField(rootFieldKey);
			visitor.free();

			const updated = forest.roots.fields.get(rootFieldKey);
			assert(updated !== undefined);
			assert.equal(updated.length, 1);
			assert(updated[0] instanceof UniformChunk);
			assert.equal(updated[0].topLevelLength, 5);
		});

		it("releases chunks when destroying a detached field", () => {
			const forest = setupForest();
			const source = new UniformChunk(numberShape.withTopLevelLength(1), [99]);
			createField(forest, detachedKey, source);

			const visitor = forest.acquireVisitor();
			visitor.destroy(detachedKey, 1);
			visitor.free();

			assert.equal(forest.roots.fields.has(detachedKey), false);
			// The removed field owned the chunk's only reference.
			assert.equal(source.isUnreferenced(), true);
		});
	});
});
