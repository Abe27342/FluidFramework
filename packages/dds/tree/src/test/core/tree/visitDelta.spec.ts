/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { deepFreeze } from "@fluidframework/test-runtime-utils/internal";

import {
	type DeltaDetachedNodeChanges,
	type DeltaDetachedNodeId,
	type DeltaDetachedNodeRename,
	type DeltaFieldChanges,
	type DeltaMark,
	type DeltaRoot,
	type DeltaVisitor,
	type DetachedFieldIndex,
	type DetachedFieldRange,
	type FieldKey,
	type MapTree,
	type RevisionTag,
	TreeStoredSchemaRepository,
	combineVisitors,
	createAnnouncedVisitor,
	makeDetachedFieldIndex,
	makeDetachedNodeId,
	mapCursorField,
	rootFieldKey,
	visitDelta,
} from "../../../core/index.js";
import {
	buildChunkedForest,
	defaultIncrementalEncodingPolicy,
	defaultSchemaPolicy,
	makeTreeChunker,
	mapTreeFromCursor,
} from "../../../feature-libraries/index.js";
import {
	TreeShape,
	UniformChunk,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../feature-libraries/chunked-forest/uniformChunk.js";
import { numberSchema } from "../../../simple-tree/index.js";
import { brand, makeArray } from "../../../util/index.js";
import { cursorToJsonObject } from "../../json/index.js";
import { jsonSequenceRootSchema } from "../../sequenceRootUtils.js";
import {
	chunkFromJsonTrees,
	chunkToMapTreeField,
	mintRevisionTag,
	rootFromDeltaFieldMap,
	type DeltaParams,
} from "../../utils.js";

function visit(
	delta: DeltaRoot,
	visitor: DeltaVisitor,
	detachedFieldIndex?: DetachedFieldIndex,
	revision?: RevisionTag,
	allowGroupedDetaches = false,
): void {
	deepFreeze(delta);
	visitDelta(
		delta,
		visitor,
		detachedFieldIndex ?? makeDetachedFieldIndex(""),
		revision,
		allowGroupedDetaches,
	);
}

/**
 * Creates separate singleton fields to match the visitor scripts in this suite.
 */
function createSingletonFields(
	index: DetachedFieldIndex,
	id: DeltaDetachedNodeId,
	count: number,
): void {
	for (let offset = 0; offset < count; offset++) {
		index.createRange(makeDetachedNodeId(id.major, id.minor + offset), undefined);
	}
}

/**
 * Asserts the singleton layout expected by these scripts before omitting range metadata.
 */
function* singletonFields(
	index: DetachedFieldIndex,
): IterableIterator<Omit<DetachedFieldRange, "count" | "index">> {
	for (const { count, index: offset, latestRelevantRevision, ...field } of index.ranges()) {
		assert.equal(count, 1);
		assert.equal(offset, 0);
		yield latestRelevantRevision === undefined ? field : { ...field, latestRelevantRevision };
	}
}

type CallSignatures<T> = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[K in keyof T]: T[K] extends (...args: any) => any ? [K, ...Parameters<T[K]>] : never;
};
type PropType<T> = T[keyof T];
type VisitCall =
	| PropType<CallSignatures<Omit<DeltaVisitor, "create">>>
	| ["create", MapTree[], FieldKey];
type VisitScript = VisitCall[];

const visitorMethods: (keyof DeltaVisitor)[] = [
	"create",
	"destroy",
	"attach",
	"detach",
	"replace",
	"enterNode",
	"exitNode",
	"enterField",
	"exitField",
];

/**
 * Calls visitDelta on a DeltaRoot and checks that the result is as expected.
 *
 * @param delta - the root delta to visit
 * @param expected - the expected result of the call to visitDelta
 * @param detachedFieldIndex - an optional detached field index to get refresher data from
 * @param revision - an optional revision for the delta being visited
 * @param allowGroupedDetaches - whether traversal may create fields containing multiple nodes
 */
function testDeltaVisit(
	delta: DeltaRoot,
	expected: Readonly<VisitScript>,
	detachedFieldIndex?: DetachedFieldIndex,
	revision?: RevisionTag,
	allowGroupedDetaches = false,
): void {
	let callIndex = 0;
	const result: VisitScript = [];
	const makeChecker =
		(name: keyof DeltaVisitor) =>
		(...args: unknown[]) => {
			const call: VisitCall =
				name === "create"
					? ([
							name,
							(args as Parameters<DeltaVisitor["create"]>)[0].map(mapTreeFromCursor),
							args[1],
						] as VisitCall)
					: ([name, ...args] as VisitCall);
			result.push(call);
			// To break when the first off script event happens, enable this line:
			// assert.deepStrictEqual([name, ...args], expected[callIndex]);
			callIndex += 1;
		};
	const visitor: DeltaVisitor = {} as unknown as DeltaVisitor;
	for (const methodName of visitorMethods) {
		visitor[methodName] = makeChecker(methodName);
	}
	visit(delta, visitor, detachedFieldIndex, revision, allowGroupedDetaches);
	assert.deepEqual(result, expected);
}

/**
 * Creates a DeltaRoot from the provided parameters and calls `testDeltaVisit` on the result.
 */
function testTreeVisit(
	marks: DeltaFieldChanges,
	expected: Readonly<VisitScript>,
	params?: DeltaParams,
	allowGroupedDetaches = false,
): void {
	const { detachedFieldIndex, revision, global, rename, build, destroy } = params ?? {};
	const rootDelta = rootFromDeltaFieldMap(
		new Map([[rootKey, marks]]),
		global,
		rename,
		build,
		destroy,
	);
	testDeltaVisit(rootDelta, expected, detachedFieldIndex, revision, allowGroupedDetaches);
}

const rootKey: FieldKey = brand("root");
const fooKey: FieldKey = brand("foo");
const barKey: FieldKey = brand("bar");
const chunkX = chunkFromJsonTrees(["X"]);
const chunkY = chunkFromJsonTrees(["Y"]);
const chunkXY = chunkFromJsonTrees(["X", "Y"]);
const mapTreeX = chunkToMapTreeField(chunkX);
const mapTreeY = chunkToMapTreeField(chunkY);
const field0: FieldKey = brand("-0");
const field1: FieldKey = brand("-1");
const field2: FieldKey = brand("-2");
const field3: FieldKey = brand("-3");

describe("visitDelta", () => {
	describe("grouped detached fields", () => {
		for (const count of [16, 65_536]) {
			it(`detaches and destroys ${count} leaves without per-node visitor or index records`, () => {
				const schema = new TreeStoredSchemaRepository(jsonSequenceRootSchema);
				const forest = buildChunkedForest(
					makeTreeChunker(schema, defaultSchemaPolicy, defaultIncrementalEncodingPolicy),
				);
				const shape = new TreeShape(brand(numberSchema.identifier), true, []);
				const chunk = new UniformChunk(
					shape.withTopLevelLength(count),
					makeArray(count, () => 0),
				);
				forest.roots.fields.set(rootFieldKey, [chunk]);
				const last = forest.anchors.track({
					parent: undefined,
					parentField: rootFieldKey,
					parentIndex: count - 1,
				});
				const index = makeDetachedFieldIndex("");
				const calls: unknown[][] = [];
				const apply = (delta: DeltaRoot): void => {
					const visitor = combineVisitors([
						forest.acquireVisitor(),
						forest.anchors.acquireVisitor(),
						createAnnouncedVisitor({
							create: (...args) => calls.push(["create", ...args]),
							detach: (...args) => calls.push(["detach", ...args]),
							destroy: (...args) => calls.push(["destroy", ...args]),
						}),
					]);
					visitDelta(delta, visitor, index, mintRevisionTag(), true);
					visitor.free();
				};
				const id = { minor: 10 };
				apply({ fields: new Map([[rootFieldKey, { marks: [{ count, detach: id }] }]]) });
				assert.deepEqual(calls, [["detach", { start: 0, end: count }, field0, id, false]]);
				assert.equal([...index.ranges()].length, 1);
				assert.deepEqual(index.getFirst(id, count), {
					value: { root: 0, index: 0 },
					length: count,
				});
				assert.deepEqual(forest.roots.fields.get(field0), [chunk]);
				assert.equal(forest.roots.fields.has(rootFieldKey), false);
				assert.deepEqual(forest.anchors.locate(last)?.detachedNodeId, {
					minor: 10 + count - 1,
				});
				index.updateLatestRevision({ minor: 10 + count / 2 }, mintRevisionTag());
				assert.equal([...index.ranges()].length, 3);
				apply({ destroy: [{ id, count }] });
				assert.deepEqual(calls[1], ["destroy", field0, { start: 0, end: count }]);
				assert.equal(calls.length, 2);
				assert.equal([...index.ranges()].length, 0);
				assert.equal(forest.isEmpty, true);
				assert.equal(chunk.isUnreferenced(), true);
				assert.equal(forest.anchors.locate(last), undefined);
				forest.anchors.forget(last);
			});
		}

		it("resolves shifted node indices after partial attachment", () => {
			const index = makeDetachedFieldIndex("");
			index.createRange({ minor: 10 }, undefined, 5);
			testTreeVisit(
				{ marks: [{ count: 2, attach: { minor: 11 } }] },
				[
					["enterField", rootKey],
					["exitField", rootKey],
					["enterField", rootKey],
					["attach", field0, { start: 1, end: 3 }, 0],
					["exitField", rootKey],
				],
				{ detachedFieldIndex: index },
				true,
			);
			assert.deepEqual(index.getFieldRanges(brand(0), { start: 0, end: 3 }), [
				{ id: { minor: 10 }, count: 1 },
				{ id: { minor: 13 }, count: 2 },
			]);
			testTreeVisit(
				{ marks: [{ count: 2, attach: { minor: 13 } }] },
				[
					["enterField", rootKey],
					["exitField", rootKey],
					["enterField", rootKey],
					["attach", field0, { start: 1, end: 3 }, 0],
					["exitField", rootKey],
				],
				{ detachedFieldIndex: index },
				true,
			);
			assert.deepEqual(index.getLocation({ minor: 10 }), { root: 0, index: 0 });
		});

		it("keeps pending edits for different roots in the same field", () => {
			const index = makeDetachedFieldIndex("");
			index.createRange({ minor: 0 }, undefined, 10);
			const nodes: number[] = [];
			const attaches: number[] = [];
			const visitor = createAnnouncedVisitor({
				enterNode: (node) => nodes.push(node),
				attach: (_source, range) => attaches.push(range.end - range.start),
			});
			const fields: DeltaDetachedNodeChanges["fields"] = new Map([[fooKey, { marks: [] }]]);
			visitDelta(
				{
					global: [
						{ id: { minor: 3 }, fields },
						{ id: { minor: 7 }, fields },
					],
					fields: new Map([[rootKey, { marks: [{ count: 10, attach: { minor: 0 } }] }]]),
				},
				visitor,
				index,
				mintRevisionTag(),
				true,
			);
			visitor.free();
			assert.deepEqual(nodes, [3, 7, 3, 7]);
			assert.deepEqual(attaches, [3, 1, 3, 1, 2]);
			assert.equal([...index.ranges()].length, 0);
		});

		it("edits generic detached roots before and after a partial restore", () => {
			const schema = new TreeStoredSchemaRepository(jsonSequenceRootSchema);
			const forest = buildChunkedForest(
				makeTreeChunker(schema, defaultSchemaPolicy, defaultIncrementalEncodingPolicy),
			);
			forest.roots.fields.set(rootFieldKey, [
				chunkFromJsonTrees(["a", "b", "c", "d", "e"].map((child) => ({ child }))),
			]);
			const index = makeDetachedFieldIndex("");
			const childKey: FieldKey = brand("child");
			const apply = (delta: DeltaRoot): void => {
				const visitor = combineVisitors([
					forest.acquireVisitor(),
					forest.anchors.acquireVisitor(),
				]);
				visitDelta(delta, visitor, index, mintRevisionTag(), true);
				visitor.free();
				for (const { trees } of delta.build ?? []) {
					trees.referenceRemoved();
				}
			};
			const read = (field: FieldKey): unknown[] => {
				const cursor = forest.allocateCursor();
				forest.tryMoveCursorToField({ fieldKey: field, parent: undefined }, cursor);
				const values = mapCursorField(cursor, cursorToJsonObject);
				cursor.free();
				return values;
			};
			const replaceChild = (
				attach: number,
				detach: number,
			): DeltaDetachedNodeChanges["fields"] =>
				new Map([
					[
						childKey,
						{ marks: [{ count: 1, attach: { minor: attach }, detach: { minor: detach } }] },
					],
				]);
			apply({
				fields: new Map([[rootFieldKey, { marks: [{ count: 5, detach: { minor: 100 } }] }]]),
			});
			apply({
				build: [{ id: { minor: 300 }, trees: chunkFromJsonTrees(["changed-b", "changed-d"]) }],
				global: [
					{ id: { minor: 101 }, fields: replaceChild(300, 400) },
					{ id: { minor: 103 }, fields: replaceChild(301, 401) },
				],
			});
			assert.deepEqual(
				read(field0),
				["a", "changed-b", "c", "changed-d", "e"].map((child) => ({ child })),
			);
			apply({
				fields: new Map([[rootFieldKey, { marks: [{ count: 3, attach: { minor: 101 } }] }]]),
			});
			assert.deepEqual(
				read(rootFieldKey),
				["changed-b", "c", "changed-d"].map((child) => ({ child })),
			);
			assert.deepEqual(index.getFieldRanges(brand(0), { start: 0, end: 2 }), [
				{ id: { minor: 100 }, count: 1 },
				{ id: { minor: 104 }, count: 1 },
			]);
			apply({
				build: [{ id: { minor: 302 }, trees: chunkFromJsonTrees(["changed-e"]) }],
				global: [{ id: { minor: 104 }, fields: replaceChild(302, 402) }],
			});
			assert.deepEqual(read(field0), [{ child: "a" }, { child: "changed-e" }]);
			assert.deepEqual(index.getLocation({ minor: 104 }), { root: 0, index: 1 });
		});

		it("preserves pending node identities through a batched rename and attachment", () => {
			const index = makeDetachedFieldIndex("");
			index.createRange({ minor: 0 }, undefined, 10);
			const visited: number[] = [];
			const transfers: number[] = [];
			const visitor = createAnnouncedVisitor({
				enterNode: (node) => visited.push(node),
				detach: (range) => transfers.push(range.end - range.start),
			});
			const fields: DeltaDetachedNodeChanges["fields"] = new Map([[fooKey, { marks: [] }]]);
			visitDelta(
				{
					global: [
						{ id: { minor: 3 }, fields },
						{ id: { minor: 7 }, fields },
					],
					rename: [{ oldId: { minor: 0 }, newId: { minor: 100 }, count: 10 }],
					fields: new Map([[rootKey, { marks: [{ count: 10, attach: { minor: 100 } }] }]]),
				},
				visitor,
				index,
				undefined,
				true,
			);
			visitor.free();
			assert.deepEqual(visited, [3, 7, 3, 7]);
			assert.deepEqual(transfers, [10]);
			assert.equal([...index.ranges()].length, 0);
		});

		it("replaces a contiguous range in one call", () => {
			const index = makeDetachedFieldIndex("");
			index.createRange({ minor: 0 }, undefined, 1000);
			testTreeVisit(
				{ marks: [{ count: 1000, attach: { minor: 0 }, detach: { minor: 1000 } }] },
				[
					["enterField", rootKey],
					[
						"replace",
						field0,
						{ start: 0, end: 1000 },
						{ start: 0, end: 1000 },
						field1,
						{ minor: 1000 },
					],
					["exitField", rootKey],
					["enterField", rootKey],
					["exitField", rootKey],
				],
				{ detachedFieldIndex: index },
				true,
			);
			assert.equal([...index.ranges()].length, 1);
			assert.equal(index.getFirst({ minor: 1000 }, 1000).length, 1000);
		});

		it("transfers only the requested detached node ID run from a fragmented forest field", () => {
			const index = makeDetachedFieldIndex("");
			const root = index.createRange({ minor: 0 }, undefined, 5);
			index.deleteRange(root, { start: 1, end: 3 });
			testDeltaVisit(
				{ rename: [{ oldId: { minor: 3 }, newId: { minor: 20 }, count: 2 }] },
				[
					["enterField", field0],
					["detach", { start: 1, end: 3 }, field1, { minor: 20 }, false],
					["exitField", field0],
				],
				index,
				undefined,
				true,
			);
			assert.deepEqual(index.getLocation({ minor: 0 }), { root: 0, index: 0 });
			assert.deepEqual(index.getFirst({ minor: 20 }, 2), {
				value: { root: 1, index: 0 },
				length: 2,
			});
		});

		for (const shift of [-1, 1]) {
			it(`renames an overlapping contiguous range in bulk (shift ${shift})`, () => {
				const index = makeDetachedFieldIndex("");
				index.createRange({ minor: 10 }, undefined, 1000);
				const newId = { minor: 10 + shift };
				testDeltaVisit(
					{ rename: [{ oldId: { minor: 10 }, newId, count: 1000 }] },
					[
						["enterField", field0],
						["detach", { start: 0, end: 1000 }, field1, newId, false],
						["exitField", field0],
					],
					index,
					undefined,
					true,
				);
				assert.deepEqual(index.getFirst(newId, 1000), {
					value: { root: 1, index: 0 },
					length: 1000,
				});
				assert.equal([...index.ranges()].length, 1);
			});
		}

		it("splits rename dependencies at occupied destination boundaries", () => {
			const index = makeDetachedFieldIndex("");
			index.createRange({ minor: 0 }, undefined, 3);
			index.createRange({ minor: 10 }, undefined, 1);
			const transfers: number[] = [];
			const visitor = createAnnouncedVisitor({
				detach: (range) => transfers.push(range.end - range.start),
			});
			visitDelta(
				{
					rename: [
						{ oldId: { minor: 0 }, newId: { minor: 10 }, count: 3 },
						{ oldId: { minor: 10 }, newId: { minor: 20 }, count: 1 },
					],
				},
				visitor,
				index,
				undefined,
				true,
			);
			visitor.free();
			assert.deepEqual(transfers, [2, 1, 1]);
			assert.equal(index.tryGetLocation({ minor: 0 }), undefined);
			assert.equal(index.getFirst({ minor: 11 }, 2).length, 2);
			assert.notEqual(index.tryGetLocation({ minor: 10 }), undefined);
			assert.notEqual(index.tryGetLocation({ minor: 20 }), undefined);
		});
	});

	it("empty delta", () => {
		testTreeVisit({ marks: [] }, [
			["enterField", rootKey],
			["exitField", rootKey],
			["enterField", rootKey],
			["exitField", rootKey],
		]);
	});
	it("insert root", () => {
		const index = makeDetachedFieldIndex("");
		const node = { minor: 42 };
		const rootFieldDelta: DeltaFieldChanges = { marks: [{ count: 1, attach: node }] };
		const delta: DeltaRoot = {
			build: [{ id: node, trees: chunkX }],
			fields: new Map([[rootKey, rootFieldDelta]]),
		};
		const expected: VisitScript = [
			["create", mapTreeX, field0],
			["enterField", rootKey],
			["exitField", rootKey],
			["enterField", rootKey],
			["attach", field0, { start: 0, end: 1 }, 0],
			["exitField", rootKey],
		];
		testDeltaVisit(delta, expected, index);
		assert.deepEqual([...index.ranges()], []);
	});
	it("throws on build of existing tree", () => {
		const index = makeDetachedFieldIndex("");
		const node = { minor: 42 };
		index.createRange(node, undefined);
		const rootFieldDelta: DeltaFieldChanges = { marks: [{ count: 1, attach: node }] };
		const delta: DeltaRoot = {
			build: [{ id: node, trees: chunkX }],
			fields: new Map([[rootKey, rootFieldDelta]]),
		};
		assert.throws(() => testDeltaVisit(delta, [], index));
		assert.deepEqual([...singletonFields(index)], [{ id: { minor: 42 }, root: 0 }]);
	});
	it("insert child", () => {
		const index = makeDetachedFieldIndex("");
		const buildId = { minor: 42 };
		const rootFieldDelta: DeltaFieldChanges = {
			marks: [
				{
					count: 1,
					fields: new Map([[fooKey, { marks: [{ count: 1, attach: buildId }] }]]),
				},
			],
		};
		const expected: VisitScript = [
			["create", mapTreeX, field0],
			["enterField", rootKey],
			["enterNode", 0],
			["enterField", fooKey],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", rootKey],
			["enterField", rootKey],
			["enterNode", 0],
			["enterField", fooKey],
			["attach", field0, { start: 0, end: 1 }, 0],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", rootKey],
		];
		const delta: DeltaRoot = {
			build: [{ id: buildId, trees: chunkX }],
			fields: new Map([[rootKey, rootFieldDelta]]),
		};
		testDeltaVisit(delta, expected, index);
		assert.deepEqual([...index.ranges()], []);
	});
	it("remove root", () => {
		const index = makeDetachedFieldIndex("");
		const mark: DeltaMark = {
			count: 2,
			detach: { minor: 42 },
		};
		const marks = [{ count: 1 }, mark];
		testTreeVisit(
			{ marks },
			[
				["enterField", rootKey],
				["detach", { start: 1, end: 2 }, field0, { minor: 42 }, false],
				["detach", { start: 1, end: 2 }, field1, { minor: 43 }, false],
				["exitField", rootKey],
				["enterField", rootKey],
				["exitField", rootKey],
			],
			{
				detachedFieldIndex: index,
			},
		);
		assert.deepEqual(
			[...singletonFields(index)],
			[
				{ id: { minor: 42 }, root: 0 },
				{ id: { minor: 43 }, root: 1 },
			],
		);
	});
	it("remove child", () => {
		const index = makeDetachedFieldIndex("");
		const remove: DeltaMark = {
			count: 1,
			detach: { minor: 42 },
		};
		const mark: DeltaMark = {
			count: 1,
			fields: new Map([[fooKey, { marks: [{ count: 42 }, remove] }]]),
		};
		const expected: VisitScript = [
			["enterField", rootKey],
			["enterNode", 0],
			["enterField", fooKey],
			["detach", { start: 42, end: 43 }, field0, { minor: 42 }, false],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", rootKey],
			["enterField", rootKey],
			["enterNode", 0],
			["enterField", fooKey],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", rootKey],
		];
		testTreeVisit({ marks: [mark] }, expected, { detachedFieldIndex: index });
		assert.deepEqual([...singletonFields(index)], [{ id: { minor: 42 }, root: 0 }]);
	});
	it("keeps a four-node detach as four singleton producer calls and fields", () => {
		const index = makeDetachedFieldIndex("");
		testTreeVisit(
			{ marks: [{ count: 4, detach: { minor: 42 } }] },
			[
				["enterField", rootKey],
				["detach", { start: 0, end: 1 }, field0, { minor: 42 }, false],
				["detach", { start: 0, end: 1 }, field1, { minor: 43 }, false],
				["detach", { start: 0, end: 1 }, field2, { minor: 44 }, false],
				["detach", { start: 0, end: 1 }, field3, { minor: 45 }, false],
				["exitField", rootKey],
				["enterField", rootKey],
				["exitField", rootKey],
			],
			{ detachedFieldIndex: index },
		);
		assert.deepEqual(
			[...singletonFields(index)],
			[
				{ id: { minor: 42 }, root: 0 },
				{ id: { minor: 43 }, root: 1 },
				{ id: { minor: 44 }, root: 2 },
				{ id: { minor: 45 }, root: 3 },
			],
		);
	});

	for (const operation of ["detach", "replace"] as const) {
		it(`chooses ${operation} destination grouping per call without changing the index`, () => {
			const index = makeDetachedFieldIndex("");
			if (operation === "replace") {
				index.createRange({ minor: 0 }, undefined, 4);
			}
			const detachedCounts: number[] = [];
			const visitor = createAnnouncedVisitor({
				detach: (range) => detachedCounts.push(range.end - range.start),
				replace: (_source, _sourceRange, range) =>
					detachedCounts.push(range.end - range.start),
			});
			const delta = (minor: number, attachMinor: number): DeltaRoot => ({
				fields: new Map([
					[
						rootKey,
						{
							marks: [
								{
									count: 2,
									detach: { minor },
									...(operation === "replace" ? { attach: { minor: attachMinor } } : {}),
								},
							],
						},
					],
				]),
			});

			visit(delta(10, 0), visitor, index);
			assert.deepEqual(detachedCounts, [1, 1]);
			assert.notEqual(
				index.getLocation({ minor: 10 }).root,
				index.getLocation({ minor: 11 }).root,
			);
			assert.equal(index.getFirst({ minor: 10 }, 2).length, 1);

			visit(delta(12, 2), visitor, index, undefined, true);
			visitor.free();
			assert.deepEqual(detachedCounts, [1, 1, 2]);
			const groupedRoot = index.getLocation({ minor: 12 }).root;
			assert.deepEqual(index.getFirst({ minor: 12 }, 2), {
				value: { root: groupedRoot, index: 0 },
				length: 2,
			});
			assert.deepEqual(index.getLocation({ minor: 13 }), { root: groupedRoot, index: 1 });
			assert.deepEqual(
				[...index.ranges()].map(({ count }) => count),
				[1, 1, 2],
			);
		});
	}

	for (const operation of ["attach", "destroy"] as const) {
		it(`re-resolves grouped input locations during ${operation} without enabling grouped producers`, () => {
			const index = makeDetachedFieldIndex("");
			const root = index.createRange({ minor: 10 }, undefined, 5);
			const delta: DeltaRoot =
				operation === "attach"
					? {
							fields: new Map([[rootKey, { marks: [{ count: 3, attach: { minor: 11 } }] }]]),
						}
					: { destroy: [{ id: { minor: 11 }, count: 3 }] };
			const expected: VisitScript =
				operation === "attach"
					? [
							["enterField", rootKey],
							["exitField", rootKey],
							["enterField", rootKey],
							["attach", field0, { start: 1, end: 4 }, 0],
							["exitField", rootKey],
						]
					: [["destroy", field0, { start: 1, end: 4 }]];
			testDeltaVisit(delta, expected, index);
			assert.deepEqual(index.getFieldRanges(root, { start: 0, end: 2 }), [
				{ id: { minor: 10 }, count: 1 },
				{ id: { minor: 14 }, count: 1 },
			]);
			assert.deepEqual(index.getLocation({ minor: 10 }), { root, index: 0 });
			assert.deepEqual(index.getLocation({ minor: 14 }), { root, index: 1 });
			for (const minor of [11, 12, 13]) {
				assert.equal(index.tryGetLocation({ minor }), undefined);
			}
			if (operation === "attach") {
				testTreeVisit(
					{ marks: [{ count: 1, attach: { minor: 14 } }] },
					[
						["enterField", rootKey],
						["exitField", rootKey],
						["enterField", rootKey],
						["attach", field0, { start: 1, end: 2 }, 0],
						["exitField", rootKey],
					],
					{ detachedFieldIndex: index },
				);
			} else {
				testDeltaVisit(
					{ destroy: [{ id: { minor: 14 }, count: 1 }] },
					[["destroy", field0, { start: 1, end: 2 }]],
					index,
				);
			}
			assert.deepEqual(index.getFieldRanges(root, { start: 0, end: 1 }), [
				{ id: { minor: 10 }, count: 1 },
			]);
		});
	}

	it("changes under insert", () => {
		const index = makeDetachedFieldIndex("");
		const moveId = { minor: 1 };
		const moveOut: DeltaMark = {
			count: 1,
			detach: moveId,
		};
		const moveIn: DeltaMark = {
			count: 1,
			attach: moveId,
		};
		const delta: DeltaRoot = {
			global: [
				{
					id: { minor: 43 },
					fields: new Map([[fooKey, { marks: [{ count: 42 }, moveOut, moveIn] }]]),
				},
			],
			build: [{ id: { minor: 43 }, trees: chunkX }],
			fields: new Map([[rootKey, { marks: [{ count: 1, attach: { minor: 43 } }] }]]),
		};
		const expected: VisitScript = [
			["create", mapTreeX, field0],
			["enterField", rootKey],
			["exitField", rootKey],
			["enterField", field0],
			["enterNode", 0],
			["enterField", fooKey],
			["detach", { start: 42, end: 43 }, field1, moveId, false],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", field0],
			["enterField", rootKey],
			["attach", field0, { start: 0, end: 1 }, 0],
			["enterNode", 0],
			["enterField", fooKey],
			["attach", field1, { start: 0, end: 1 }, 42],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", rootKey],
		];
		testDeltaVisit(delta, expected, index);
		assert.deepEqual([...index.ranges()], []);
	});
	it("move node to the right", () => {
		const index = makeDetachedFieldIndex("");
		// start with 0123 then move 1 so the order is 0213
		const moveId = { minor: 1 };
		const moveOut: DeltaMark = {
			count: 1,
			detach: moveId,
		};
		const moveIn: DeltaMark = {
			count: 1,
			attach: moveId,
		};
		const marks = [{ count: 1 }, moveOut, { count: 1 }, moveIn];
		const expected: VisitScript = [
			["enterField", rootKey],
			["detach", { start: 1, end: 2 }, field0, moveId, false],
			["exitField", rootKey],
			["enterField", rootKey],
			["attach", field0, { start: 0, end: 1 }, 2],
			["exitField", rootKey],
		];
		testTreeVisit({ marks }, expected, { detachedFieldIndex: index });
		assert.deepEqual([...index.ranges()], []);
	});
	it("move children to the left", () => {
		const index = makeDetachedFieldIndex("");
		const moveId = { minor: 1 };
		const moveOut: DeltaMark = {
			count: 2,
			detach: moveId,
		};
		const moveIn: DeltaMark = {
			count: 2,
			attach: moveId,
		};
		const modify: DeltaMark = {
			count: 1,
			fields: new Map([[fooKey, { marks: [{ count: 2 }, moveIn, { count: 3 }, moveOut] }]]),
		};
		const marks = [modify];
		const expected: VisitScript = [
			["enterField", rootKey],
			["enterNode", 0],
			["enterField", fooKey],
			["detach", { start: 5, end: 6 }, field0, { minor: 1 }, false],
			["detach", { start: 5, end: 6 }, field1, { minor: 2 }, false],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", rootKey],
			["enterField", rootKey],
			["enterNode", 0],
			["enterField", fooKey],
			["attach", field0, { start: 0, end: 1 }, 2],
			["attach", field1, { start: 0, end: 1 }, 3],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", rootKey],
		];
		testTreeVisit({ marks }, expected, { detachedFieldIndex: index });
		assert.deepEqual([...index.ranges()], []);
	});
	it("move cousins", () => {
		const index = makeDetachedFieldIndex("");
		const moveId = { minor: 1 };
		const moveOut: DeltaMark = {
			count: 1,
			detach: moveId,
		};
		const moveIn: DeltaMark = {
			count: 1,
			attach: moveId,
		};
		const modify: DeltaMark = {
			count: 1,
			fields: new Map([
				[fooKey, { marks: [moveIn] }],
				[barKey, { marks: [moveOut] }],
			]),
		};
		const marks = [modify];
		const expected: VisitScript = [
			["enterField", rootKey],
			["enterNode", 0],
			["enterField", fooKey],
			["exitField", fooKey],
			["enterField", barKey],
			["detach", { start: 0, end: 1 }, field0, moveId, false],
			["exitField", barKey],
			["exitNode", 0],
			["exitField", rootKey],
			["enterField", rootKey],
			["enterNode", 0],
			["enterField", fooKey],
			["attach", field0, { start: 0, end: 1 }, 0],
			["exitField", fooKey],
			["enterField", barKey],
			["exitField", barKey],
			["exitNode", 0],
			["exitField", rootKey],
		];
		testTreeVisit({ marks }, expected, { detachedFieldIndex: index });
		assert.deepEqual([...index.ranges()], []);
	});
	it("changes under remove", () => {
		const index = makeDetachedFieldIndex("");
		const moveId = { minor: 1 };
		const moveOut: DeltaMark = {
			count: 1,
			detach: moveId,
		};
		const moveIn: DeltaMark = {
			count: 1,
			attach: moveId,
		};
		const remove: DeltaMark = {
			detach: { minor: 42 },
			count: 1,
			fields: new Map([[fooKey, { marks: [moveOut, moveIn] }]]),
		};
		const marks = [remove];
		const expected: VisitScript = [
			["enterField", rootKey],
			["enterNode", 0],
			["enterField", fooKey],
			["detach", { start: 0, end: 1 }, field0, moveId, false],
			["exitField", fooKey],
			["exitNode", 0],
			["detach", { start: 0, end: 1 }, field1, { minor: 42 }, false],
			["exitField", rootKey],
			["enterField", rootKey],
			["exitField", rootKey],
			["enterField", field1],
			["enterNode", 0],
			["enterField", fooKey],
			["attach", field0, { start: 0, end: 1 }, 0],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", field1],
		];
		testTreeVisit({ marks }, expected, { detachedFieldIndex: index });
		assert.deepEqual([...singletonFields(index)], [{ id: { minor: 42 }, root: 1 }]);
	});
	it("changes under destroy", () => {
		const index = makeDetachedFieldIndex("");
		const node1 = { minor: 42 };
		index.createRange(node1, undefined);
		const moveId = { minor: 1 };
		const moveOut: DeltaMark = {
			count: 1,
			detach: moveId,
		};
		const moveIn: DeltaMark = {
			count: 1,
			attach: moveId,
		};
		const nested: DeltaDetachedNodeChanges = {
			id: node1,
			fields: new Map([[fooKey, { marks: [moveOut, moveIn] }]]),
		};
		const delta: DeltaRoot = {
			global: [nested],
			destroy: [{ id: node1, count: 1 }],
		};
		const expected: VisitScript = [
			["enterField", field0],
			["enterNode", 0],
			["enterField", fooKey],
			["detach", { start: 0, end: 1 }, field1, moveId, false],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", field0],
			["enterField", field0],
			["enterNode", 0],
			["enterField", fooKey],
			["attach", field1, { start: 0, end: 1 }, 0],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", field0],
			["destroy", field0, { start: 0, end: 1 }],
		];
		testDeltaVisit(delta, expected, index);
		assert.deepEqual([...index.ranges()], []);
	});
	it("destroy (root level)", () => {
		const index = makeDetachedFieldIndex("");
		const id = { minor: 42 };
		createSingletonFields(index, id, 2);
		const delta: DeltaRoot = {
			destroy: [{ id, count: 2 }],
		};
		const expected: VisitScript = [
			["destroy", field0, { start: 0, end: 1 }],
			["destroy", field1, { start: 0, end: 1 }],
		];
		testDeltaVisit(delta, expected, index);
		assert.deepEqual([...index.ranges()], []);
	});
	it("build-rename-destroy (field level)", () => {
		const index = makeDetachedFieldIndex("");
		const buildId = { minor: 42 };
		const detachId = { minor: 43 };
		const delta: DeltaRoot = {
			rename: [{ oldId: buildId, newId: detachId, count: 1 }],
			build: [{ id: buildId, trees: chunkX }],
			destroy: [{ id: detachId, count: 1 }],
		};
		const expected: VisitScript = [
			["create", mapTreeX, field0],
			["enterField", field0],
			["detach", { start: 0, end: 1 }, field1, detachId, false],
			["exitField", field0],
			["destroy", field1, { start: 0, end: 1 }],
		];
		testDeltaVisit(delta, expected, index);
		assert.deepEqual([...index.ranges()], []);
	});
	it("changes under move-out", () => {
		const index = makeDetachedFieldIndex("");
		const moveId1 = { minor: 1 };
		const moveId2 = { minor: 2 };
		const moveIn1: DeltaMark = {
			count: 1,
			attach: moveId1,
		};
		const moveOut2: DeltaMark = {
			count: 1,
			detach: moveId2,
		};
		const moveIn2: DeltaMark = {
			count: 1,
			attach: moveId2,
		};
		const moveOut1: DeltaMark = {
			count: 1,
			detach: moveId1,
			fields: new Map([[fooKey, { marks: [moveOut2, moveIn2] }]]),
		};
		const marks = [moveOut1, moveIn1];
		const expected: VisitScript = [
			["enterField", rootKey],
			["enterNode", 0],
			["enterField", fooKey],
			["detach", { start: 0, end: 1 }, field0, moveId2, false],
			["exitField", fooKey],
			["exitNode", 0],
			["detach", { start: 0, end: 1 }, field1, moveId1, false],
			["exitField", rootKey],
			["enterField", rootKey],
			["attach", field1, { start: 0, end: 1 }, 0],
			["enterNode", 0],
			["enterField", fooKey],
			["attach", field0, { start: 0, end: 1 }, 0],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", rootKey],
		];
		testTreeVisit({ marks }, expected, { detachedFieldIndex: index });
		assert.deepEqual([...index.ranges()], []);
	});

	it("changes under move-out of range", () => {
		const index = makeDetachedFieldIndex("");
		const buildId = { minor: 1 };
		const moveId = { minor: 2 };

		const attach: DeltaMark = { count: 1, attach: buildId };
		const moveIn: DeltaMark = {
			count: 2,
			attach: moveId,
		};

		const moveOut1: DeltaMark = {
			count: 1,
			detach: moveId,
		};

		const moveOut2: DeltaMark = {
			count: 1,
			detach: { minor: 3 },
			fields: new Map([[fooKey, { marks: [attach] }]]),
		};

		const fieldChanges: DeltaFieldChanges = { marks: [moveOut1, moveOut2, moveIn] };

		const delta: DeltaRoot = {
			build: [{ id: buildId, trees: chunkX }],
			fields: new Map([[rootKey, fieldChanges]]),
		};

		const expected: VisitScript = [
			["create", mapTreeX, field0],
			["enterField", rootKey],
			["detach", { start: 0, end: 1 }, field1, moveId, false],
			["enterNode", 0],
			["enterField", fooKey],
			["exitField", fooKey],
			["exitNode", 0],
			["detach", { start: 0, end: 1 }, field2, { minor: 3 }, false],
			["exitField", rootKey],
			["enterField", rootKey],
			["attach", field1, { start: 0, end: 1 }, 0],
			["attach", field2, { start: 0, end: 1 }, 1],
			["enterNode", 1],
			["enterField", fooKey],
			["attach", field0, { start: 0, end: 1 }, 0],
			["exitField", fooKey],
			["exitNode", 1],
			["exitField", rootKey],
		];

		testDeltaVisit(delta, expected, index);
		assert.deepEqual([...index.ranges()], []);
	});

	it("replace nodes", () => {
		const buildId = { minor: 0 };

		const replace: DeltaMark = {
			count: 2,
			detach: { minor: 2 },
			attach: buildId,
		};

		const fieldChanges: DeltaFieldChanges = { marks: [replace] };
		const delta: DeltaRoot = {
			build: [{ id: buildId, trees: chunkXY }],
			fields: new Map([[rootKey, fieldChanges]]),
		};

		const expected: VisitScript = [
			["create", mapTreeX, field0],
			["create", mapTreeY, field1],
			["enterField", rootKey],
			["replace", field0, { start: 0, end: 1 }, { start: 0, end: 1 }, field2, { minor: 2 }],
			["replace", field1, { start: 0, end: 1 }, { start: 1, end: 2 }, field3, { minor: 3 }],
			["exitField", rootKey],
			["enterField", rootKey],
			["exitField", rootKey],
		];

		const index = makeDetachedFieldIndex("");
		testDeltaVisit(delta, expected, index);
		assert.deepEqual(
			[...singletonFields(index)],
			[
				{ id: { minor: 2 }, root: 2 },
				{ id: { minor: 3 }, root: 3 },
			],
		);
	});
	it("keeps indexes aligned around replacements in both passes", () => {
		const delta: DeltaRoot = {
			build: [{ id: { minor: 0 }, trees: chunkXY }],
			fields: new Map([
				[
					rootKey,
					{
						marks: [
							{ count: 1, attach: { minor: 1 } },
							{ count: 1, detach: { minor: 2 }, attach: { minor: 0 } },
							{ count: 1, detach: { minor: 3 } },
							{ count: 1, fields: new Map([[fooKey, { marks: [] }]]) },
						],
					},
				],
			]),
		};
		testDeltaVisit(delta, [
			["create", mapTreeX, field0],
			["create", mapTreeY, field1],
			["enterField", rootKey],
			["replace", field0, { start: 0, end: 1 }, { start: 0, end: 1 }, field2, { minor: 2 }],
			["detach", { start: 1, end: 2 }, field3, { minor: 3 }, false],
			["enterNode", 1],
			["enterField", fooKey],
			["exitField", fooKey],
			["exitNode", 1],
			["exitField", rootKey],
			["enterField", rootKey],
			["attach", field1, { start: 0, end: 1 }, 0],
			["enterNode", 2],
			["enterField", fooKey],
			["exitField", fooKey],
			["exitNode", 2],
			["exitField", rootKey],
		]);
	});

	it("does not partially replace a range with an unavailable incoming root", () => {
		const delta: DeltaRoot = {
			build: [{ id: { minor: 0 }, trees: chunkX }],
			fields: new Map([
				[
					rootKey,
					{
						marks: [
							{ count: 2, detach: { minor: 2 }, attach: { minor: 0 } },
							{ count: 1, detach: { minor: 1 } },
						],
					},
				],
			]),
		};
		testDeltaVisit(delta, [
			["create", mapTreeX, field0],
			["enterField", rootKey],
			["detach", { start: 0, end: 1 }, field1, { minor: 2 }, true],
			["detach", { start: 0, end: 1 }, field2, { minor: 3 }, true],
			["detach", { start: 0, end: 1 }, field3, { minor: 1 }, false],
			["exitField", rootKey],
			["enterField", rootKey],
			["attach", field0, { start: 0, end: 1 }, 0],
			["attach", field3, { start: 0, end: 1 }, 1],
			["exitField", rootKey],
		]);
	});
	it("keeps replacement split when the incoming root has pending global changes", () => {
		const delta: DeltaRoot = {
			build: [{ id: { minor: 0 }, trees: chunkX }],
			global: [{ id: { minor: 0 }, fields: new Map([[fooKey, { marks: [] }]]) }],
			fields: new Map([
				[rootKey, { marks: [{ count: 1, detach: { minor: 1 }, attach: { minor: 0 } }] }],
			]),
		};
		testDeltaVisit(delta, [
			["create", mapTreeX, field0],
			["enterField", rootKey],
			["detach", { start: 0, end: 1 }, field1, { minor: 1 }, true],
			["exitField", rootKey],
			["enterField", field0],
			["enterNode", 0],
			["enterField", fooKey],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", field0],
			["enterField", rootKey],
			["attach", field0, { start: 0, end: 1 }, 0],
			["enterNode", 0],
			["enterField", fooKey],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", rootKey],
		]);
	});
	it("keeps replacement split when outgoing content is renamed", () => {
		const delta: DeltaRoot = {
			build: [{ id: { minor: 0 }, trees: chunkX }],
			rename: [{ count: 1, oldId: { minor: 1 }, newId: { minor: 2 } }],
			fields: new Map([
				[rootKey, { marks: [{ count: 1, detach: { minor: 1 }, attach: { minor: 0 } }] }],
			]),
		};
		const index = makeDetachedFieldIndex("");
		testDeltaVisit(
			delta,
			[
				["create", mapTreeX, field0],
				["enterField", rootKey],
				["detach", { start: 0, end: 1 }, field1, { minor: 1 }, true],
				["exitField", rootKey],
				["enterField", field1],
				["detach", { start: 0, end: 1 }, field2, { minor: 2 }, false],
				["exitField", field1],
				["enterField", rootKey],
				["attach", field0, { start: 0, end: 1 }, 0],
				["exitField", rootKey],
			],
			index,
		);
		assert.deepEqual([...singletonFields(index)], [{ id: { minor: 2 }, root: 2 }]);
	});
	it("destroys outgoing content after a combined replacement", () => {
		const delta: DeltaRoot = {
			build: [{ id: { minor: 0 }, trees: chunkX }],
			destroy: [{ id: { minor: 1 }, count: 1 }],
			fields: new Map([
				[rootKey, { marks: [{ count: 1, detach: { minor: 1 }, attach: { minor: 0 } }] }],
			]),
		};
		const index = makeDetachedFieldIndex("");
		testDeltaVisit(
			delta,
			[
				["create", mapTreeX, field0],
				["enterField", rootKey],
				["replace", field0, { start: 0, end: 1 }, { start: 0, end: 1 }, field1, { minor: 1 }],
				["exitField", rootKey],
				["enterField", rootKey],
				["exitField", rootKey],
				["destroy", field1, { start: 0, end: 1 }],
			],
			index,
		);
		assert.deepEqual([...index.ranges()], []);
	});

	it("changes under replaced node", () => {
		const index = makeDetachedFieldIndex("");
		const moveId1 = { minor: 1 };
		const moveId2 = { minor: 2 };
		const moveOut2: DeltaMark = {
			count: 1,
			detach: moveId2,
		};
		const moveOut1: DeltaMark = {
			count: 1,
			detach: moveId1,
		};
		const moveIn2: DeltaMark = {
			count: 1,
			attach: moveId2,
		};
		const replace: DeltaMark = {
			count: 1,
			detach: { minor: 42 },
			attach: moveId1,
			fields: new Map([[fooKey, { marks: [moveOut2, moveIn2] }]]),
		};
		const marks = [replace, moveOut1];
		const expected: VisitScript = [
			["enterField", rootKey],
			["enterNode", 0],
			["enterField", fooKey],
			["detach", { start: 0, end: 1 }, field0, moveId2, false],
			["exitField", fooKey],
			["exitNode", 0],
			["detach", { start: 0, end: 1 }, field1, { minor: 42 }, true],
			["detach", { start: 0, end: 1 }, field2, moveId1, false],
			["exitField", rootKey],
			["enterField", rootKey],
			["attach", field2, { start: 0, end: 1 }, 0],
			["exitField", rootKey],
			["enterField", field1],
			["enterNode", 0],
			["enterField", fooKey],
			["attach", field0, { start: 0, end: 1 }, 0],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", field1],
		];
		testTreeVisit({ marks }, expected, { detachedFieldIndex: index });
		assert.deepEqual([...singletonFields(index)], [{ id: { minor: 42 }, root: 1 }]);
	});

	it("changes under replacement node", () => {
		const index = makeDetachedFieldIndex("");
		const moveId1 = { minor: 1 };
		const moveId2 = { minor: 2 };
		const moveOut2: DeltaMark = {
			count: 1,
			detach: moveId2,
		};
		const moveIn2: DeltaMark = {
			count: 1,
			attach: moveId2,
		};
		const moveOut1: DeltaMark = {
			count: 1,
			detach: moveId1,
			fields: new Map([[fooKey, { marks: [moveOut2, moveIn2] }]]),
		};
		const replace: DeltaMark = {
			count: 1,
			detach: { minor: 42 },
			attach: moveId1,
		};
		const marks = [replace, moveOut1];
		const expected: VisitScript = [
			["enterField", rootKey],
			["detach", { start: 0, end: 1 }, field0, { minor: 42 }, true],
			["enterNode", 0],
			["enterField", fooKey],
			["detach", { start: 0, end: 1 }, field1, moveId2, false],
			["exitField", fooKey],
			["exitNode", 0],
			["detach", { start: 0, end: 1 }, field2, moveId1, false],
			["exitField", rootKey],
			["enterField", rootKey],
			["attach", field2, { start: 0, end: 1 }, 0],
			["enterNode", 0],
			["enterField", fooKey],
			["attach", field1, { start: 0, end: 1 }, 0],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", rootKey],
		];
		testTreeVisit({ marks }, expected, { detachedFieldIndex: index });
		assert.deepEqual([...singletonFields(index)], [{ id: { minor: 42 }, root: 0 }]);
	});
	it("transient insert", () => {
		const index = makeDetachedFieldIndex("");
		const delta: DeltaRoot = {
			build: [{ id: { minor: 42 }, trees: chunkX }],
			rename: [{ oldId: { minor: 42 }, count: 1, newId: { minor: 43 } }],
		};
		const expected: VisitScript = [
			["create", mapTreeX, field0],
			["enterField", field0],
			["detach", { start: 0, end: 1 }, field1, { minor: 43 }, false],
			["exitField", field0],
		];
		testDeltaVisit(delta, expected, index);
		assert.deepEqual([...singletonFields(index)], [{ id: { minor: 43 }, root: 1 }]);
	});
	it("changes under transient", () => {
		const index = makeDetachedFieldIndex("");
		const moveId = { minor: 1 };
		const moveOut: DeltaMark = {
			count: 1,
			detach: moveId,
		};
		const moveIn: DeltaMark = {
			count: 1,
			attach: moveId,
		};
		const buildId = { minor: 42 };
		const detachId = { minor: 43 };
		const delta: DeltaRoot = {
			build: [{ id: buildId, trees: chunkX }],
			global: [{ id: buildId, fields: new Map([[barKey, { marks: [moveOut, moveIn] }]]) }],
			rename: [{ oldId: buildId, count: 1, newId: detachId }],
		};
		const expected: VisitScript = [
			["create", mapTreeX, field0], // field0: buildId
			["enterField", field0],
			["enterNode", 0],
			["enterField", barKey],
			["detach", { start: 0, end: 1 }, field1, moveId, false], // field1: moveId
			["exitField", barKey],
			["exitNode", 0],
			["exitField", field0],
			["enterField", field0],
			["detach", { start: 0, end: 1 }, field2, detachId, false], // field2: detachId
			["exitField", field0],
			["enterField", field2],
			["enterNode", 0],
			["enterField", barKey],
			["attach", field1, { start: 0, end: 1 }, 0],
			["exitField", barKey],
			["exitNode", 0],
			["exitField", field2],
		];
		testDeltaVisit(delta, expected, index);
		assert.deepEqual([...singletonFields(index)], [{ id: detachId, root: 2 }]);
	});
	it("restore", () => {
		const index = makeDetachedFieldIndex("");
		const node1 = { minor: 1 };
		index.createRange(node1, undefined);
		const restore: DeltaMark = {
			count: 1,
			attach: node1,
		};
		const marks = [restore];
		const expected: VisitScript = [
			["enterField", rootKey],
			["exitField", rootKey],
			["enterField", rootKey],
			["attach", field0, { start: 0, end: 1 }, 0],
			["exitField", rootKey],
		];
		testTreeVisit({ marks }, expected, { detachedFieldIndex: index });
		assert.deepEqual([...index.ranges()], []);
	});
	it("move removed node", () => {
		const index = makeDetachedFieldIndex("");
		const node1 = { minor: 1 };
		index.createRange(node1, undefined);
		const moveId = { minor: 2 };
		const rename: DeltaDetachedNodeRename = {
			count: 1,
			oldId: node1,
			newId: moveId,
		};
		const moveIn: DeltaMark = {
			count: 1,
			attach: moveId,
		};
		const marks = [moveIn];
		const expected: VisitScript = [
			["enterField", rootKey],
			["exitField", rootKey],
			["enterField", field0],
			["detach", { start: 0, end: 1 }, field1, moveId, false],
			["exitField", field0],
			["enterField", rootKey],
			["attach", field1, { start: 0, end: 1 }, 0],
			["exitField", rootKey],
		];
		testTreeVisit({ marks }, expected, { detachedFieldIndex: index, rename: [rename] });
		assert.deepEqual([...index.ranges()], []);
	});
	it("changes under removed node", () => {
		const index = makeDetachedFieldIndex("");
		const node1 = { minor: 1 };
		index.createRange(node1, undefined);
		const moveId = { minor: 2 };
		const moveOut: DeltaMark = {
			count: 1,
			detach: moveId,
		};
		const moveIn: DeltaMark = {
			count: 1,
			attach: moveId,
		};
		const modify: DeltaDetachedNodeChanges = {
			id: { minor: 1 },
			fields: new Map([[fooKey, { marks: [moveOut, moveIn] }]]),
		};
		const delta = { global: [modify] };
		const expected: VisitScript = [
			["enterField", field0],
			["enterNode", 0],
			["enterField", fooKey],
			["detach", { start: 0, end: 1 }, field1, moveId, false],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", field0],
			["enterField", field0],
			["enterNode", 0],
			["enterField", fooKey],
			["attach", field1, { start: 0, end: 1 }, 0],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", field0],
		];
		testDeltaVisit(delta, expected, index);
		assert.deepEqual([...singletonFields(index)], [{ id: { minor: 1 }, root: 0 }]);
	});
	it("changes under transient move-in", () => {
		const index = makeDetachedFieldIndex("");
		const moveId1 = { minor: 1 };
		const moveId2 = { minor: 2 };
		const detachId = { minor: 42 };
		const moveOut: DeltaMark = {
			count: 1,
			detach: moveId1,
			fields: new Map([
				[
					fooKey,
					{
						marks: [
							{ count: 1, detach: moveId2 },
							{ count: 1, attach: moveId2 },
						],
					},
				],
			]),
		};
		const moveIn: DeltaDetachedNodeRename = {
			count: 1,
			oldId: moveId1,
			newId: detachId,
		};
		const delta: DeltaRoot = {
			fields: new Map([[rootKey, { marks: [moveOut] }]]),
			rename: [moveIn],
		};
		const expected: VisitScript = [
			["enterField", rootKey],
			["enterNode", 0],
			["enterField", fooKey],
			["detach", { start: 0, end: 1 }, field0, moveId2, false], // field0: moveId2
			["exitField", fooKey],
			["exitNode", 0],
			["detach", { start: 0, end: 1 }, field1, moveId1, false], // field1: moveId1
			["exitField", rootKey],
			["enterField", field1],
			["detach", { start: 0, end: 1 }, field2, detachId, false], // field2: detachId
			["exitField", field1],
			["enterField", rootKey],
			["exitField", rootKey],
			["enterField", field2],
			["enterNode", 0],
			["enterField", fooKey],
			["attach", field0, { start: 0, end: 1 }, 0],
			["exitField", fooKey],
			["exitNode", 0],
			["exitField", field2],
		];
		testDeltaVisit(delta, expected, index);
		assert.deepEqual([...singletonFields(index)], [{ id: detachId, root: 2 }]);
	});
	it("transient restore", () => {
		const index = makeDetachedFieldIndex("");
		const node1 = { minor: 1 };
		index.createRange(node1, undefined);
		const restore: DeltaDetachedNodeRename = {
			count: 1,
			oldId: node1,
			newId: { minor: 42 },
		};
		const delta = { rename: [restore] };
		const expected: VisitScript = [
			["enterField", field0],
			["detach", { start: 0, end: 1 }, field1, { minor: 42 }, false],
			["exitField", field0],
		];
		testDeltaVisit(delta, expected, index);
		assert.deepEqual([...singletonFields(index)], [{ id: { minor: 42 }, root: 1 }]);
	});
	it("update detached node", () => {
		const index = makeDetachedFieldIndex("");
		const node1 = { minor: 1 };
		index.createRange(node1, undefined);
		const buildId = { minor: 2 };
		const detachId = { minor: 42 };
		const renameOldNode: DeltaDetachedNodeRename = {
			count: 1,
			oldId: node1,
			newId: detachId,
		};
		const renameNewNode: DeltaDetachedNodeRename = {
			count: 1,
			oldId: buildId,
			newId: node1,
		};
		const delta = {
			build: [{ id: buildId, trees: chunkX }],
			rename: [renameOldNode, renameNewNode],
		};
		const expected: VisitScript = [
			["create", mapTreeX, field1], // field1: buildId
			["enterField", field0], // field0: node1
			["detach", { start: 0, end: 1 }, field2, detachId, false], // field2: detachId
			["exitField", field0],
			["enterField", field1],
			["detach", { start: 0, end: 1 }, field3, node1, false], // field3: node1
			["exitField", field1],
		];
		testDeltaVisit(delta, expected, index);
		assert.deepEqual(
			[...singletonFields(index)],
			[
				{ id: detachId, root: 2 },
				{ id: node1, root: 3 },
			],
		);
	});

	describe("refreshers", () => {
		it("for restores at the root", () => {
			const index = makeDetachedFieldIndex("");
			const node = { minor: 42 };
			const rootFieldDelta: DeltaFieldChanges = { marks: [{ count: 1, attach: node }] };
			const delta: DeltaRoot = {
				refreshers: [{ id: node, trees: chunkX }],
				fields: new Map([[rootKey, rootFieldDelta]]),
			};
			const expected: VisitScript = [
				["enterField", rootKey],
				["exitField", rootKey],
				["enterField", rootKey],
				["create", mapTreeX, field0],
				["attach", field0, { start: 0, end: 1 }, 0],
				["exitField", rootKey],
			];
			testDeltaVisit(delta, expected, index);
			assert.deepEqual([...index.ranges()], []);
		});

		it("for restores under a child", () => {
			const index = makeDetachedFieldIndex("");
			const buildId = { minor: 42 };
			const rootFieldDelta: DeltaFieldChanges = {
				marks: [
					{
						count: 1,
						fields: new Map([[fooKey, { marks: [{ count: 1, attach: buildId }] }]]),
					},
				],
			};
			const expected: VisitScript = [
				["enterField", rootKey],
				["enterNode", 0],
				["enterField", fooKey],
				["exitField", fooKey],
				["exitNode", 0],
				["exitField", rootKey],
				["enterField", rootKey],
				["enterNode", 0],
				["enterField", fooKey],
				["create", mapTreeX, field0],
				["attach", field0, { start: 0, end: 1 }, 0],
				["exitField", fooKey],
				["exitNode", 0],
				["exitField", rootKey],
			];
			const delta: DeltaRoot = {
				refreshers: [{ id: buildId, trees: chunkX }],
				fields: new Map([[rootKey, rootFieldDelta]]),
			};
			testDeltaVisit(delta, expected, index);
			assert.deepEqual([...index.ranges()], []);
		});

		it("for partial restores", () => {
			const index = makeDetachedFieldIndex("");
			const node = { minor: 42 };
			const rootFieldDelta: DeltaFieldChanges = {
				marks: [{ count: 1, attach: { minor: 43 } }],
			};
			const delta: DeltaRoot = {
				refreshers: [{ id: node, trees: chunkXY }],
				fields: new Map([[rootKey, rootFieldDelta]]),
			};
			const expected: VisitScript = [
				["enterField", rootKey],
				["exitField", rootKey],
				["enterField", rootKey],
				["create", mapTreeY, field0],
				["attach", field0, { start: 0, end: 1 }, 0],
				["exitField", rootKey],
			];
			testDeltaVisit(delta, expected, index);
			assert.deepEqual([...index.ranges()], []);
		});

		it("for changes to detached trees", () => {
			const index = makeDetachedFieldIndex("");
			const refresherId = { minor: 42 };
			const buildId = { minor: 43 };
			const expected: VisitScript = [
				["create", mapTreeX, field0],
				["create", mapTreeX, field1],
				["enterField", field1],
				["enterNode", 0],
				["enterField", fooKey],
				["exitField", fooKey],
				["exitNode", 0],
				["exitField", field1],
				["enterField", field1],
				["enterNode", 0],
				["enterField", fooKey],
				["attach", field0, { start: 0, end: 1 }, 0],
				["exitField", fooKey],
				["exitNode", 0],
				["exitField", field1],
			];
			const delta: DeltaRoot = {
				global: [
					{
						id: refresherId,
						fields: new Map([[fooKey, { marks: [{ count: 1, attach: buildId }] }]]),
					},
				],
				refreshers: [{ id: refresherId, trees: chunkX }],
				build: [{ id: buildId, trees: chunkX }],
				// TODO the global was in this so it might've changed the expected value
				// fields: new Map([[rootKey, rootFieldDelta]]),
			};
			testDeltaVisit(delta, expected, index);
		});
	});

	it("creates refreshers and updates latest revision for root transfers", () => {
		const index = makeDetachedFieldIndex("");
		const node1 = { minor: 1 };
		index.createRange(node1, undefined);
		const moveId = { minor: 2 };
		const rename: DeltaDetachedNodeRename = {
			count: 1,
			oldId: node1,
			newId: moveId,
		};
		const delta = {
			refreshers: [{ id: node1, trees: chunkX }],
			rename: [rename],
		};
		const expected: VisitScript = [
			["enterField", field0],
			["detach", { start: 0, end: 1 }, field1, moveId, false],
			["exitField", field0],
		];
		const revision = mintRevisionTag();
		testDeltaVisit(delta, expected, index, revision);
		const iteratorResult = singletonFields(index).next();
		assert.equal(iteratorResult.done, false);
		assert.deepEqual(iteratorResult.value.id, moveId);
		assert.equal(iteratorResult.value.latestRelevantRevision, revision);
	});

	describe("updates latest revision", () => {
		it("when building a detached tree", () => {
			const index = makeDetachedFieldIndex("");
			const node = { minor: 42 };
			const delta: DeltaRoot = {
				build: [{ id: node, trees: chunkX }],
			};
			const expected: VisitScript = [["create", mapTreeX, field0]];
			const revision = mintRevisionTag();
			testDeltaVisit(delta, expected, index, revision);
			assert.deepEqual(
				[...singletonFields(index)],
				[{ id: node, root: 0, latestRelevantRevision: revision }],
			);
		});

		it("when applying changes to detached trees", () => {
			const index = makeDetachedFieldIndex("");
			const node1 = { minor: 1 };
			index.createRange(node1, undefined);
			const moveId = { minor: 2 };
			const moveOut: DeltaMark = {
				count: 1,
				detach: moveId,
			};
			const moveIn: DeltaMark = {
				count: 1,
				attach: moveId,
			};
			const modify: DeltaDetachedNodeChanges = {
				id: node1,
				fields: new Map([[fooKey, { marks: [moveOut, moveIn] }]]),
			};
			const global = [modify];
			const expected: VisitScript = [
				["enterField", rootKey],
				["exitField", rootKey],
				["enterField", field0],
				["enterNode", 0],
				["enterField", fooKey],
				["detach", { start: 0, end: 1 }, field1, moveId, false],
				["exitField", fooKey],
				["exitNode", 0],
				["exitField", field0],
				["enterField", rootKey],
				["exitField", rootKey],
				["enterField", field0],
				["enterNode", 0],
				["enterField", fooKey],
				["attach", field1, { start: 0, end: 1 }, 0],
				["exitField", fooKey],
				["exitNode", 0],
				["exitField", field0],
			];
			const revision = mintRevisionTag();
			testTreeVisit({ marks: [] }, expected, { detachedFieldIndex: index, revision, global });
			assert.deepEqual(
				[...singletonFields(index)],
				[{ id: node1, root: 0, latestRelevantRevision: revision }],
			);
		});

		it("for detached trees created during replaces", () => {
			const buildId = { minor: 0 };

			const replace: DeltaMark = {
				count: 2,
				detach: { minor: 2 },
				attach: buildId,
			};

			const rootChanges: DeltaFieldChanges = { marks: [replace] };
			const delta: DeltaRoot = {
				build: [{ id: buildId, trees: chunkXY }],
				fields: new Map([[rootKey, rootChanges]]),
			};

			const expected: VisitScript = [
				["create", mapTreeX, field0],
				["create", mapTreeY, field1],
				["enterField", rootKey],
				["replace", field0, { start: 0, end: 1 }, { start: 0, end: 1 }, field2, { minor: 2 }],
				["replace", field1, { start: 0, end: 1 }, { start: 1, end: 2 }, field3, { minor: 3 }],
				["exitField", rootKey],
				["enterField", rootKey],
				["exitField", rootKey],
			];

			const revision = mintRevisionTag();
			const index = makeDetachedFieldIndex("");
			testDeltaVisit(delta, expected, index, revision);
			assert.deepEqual(
				[...singletonFields(index)],
				[
					{ id: { minor: 2 }, root: 2, latestRelevantRevision: revision },
					{ id: { minor: 3 }, root: 3, latestRelevantRevision: revision },
				],
			);
		});
	});

	describe("tolerates superfluous refreshers", () => {
		it("when the delta can be applied without the refresher", () => {
			const index = makeDetachedFieldIndex("");
			const node = { minor: 42 };
			const node2 = { minor: 43 };
			const rootFieldDelta: DeltaFieldChanges = { marks: [{ count: 1, attach: node2 }] };
			const delta: DeltaRoot = {
				refreshers: [
					{ id: node, trees: chunkX },
					{ id: node2, trees: chunkX },
				],
				fields: new Map([[rootKey, rootFieldDelta]]),
			};
			const expected: VisitScript = [
				["enterField", rootKey],
				["exitField", rootKey],
				["enterField", rootKey],
				["create", mapTreeX, field0],
				["attach", field0, { start: 0, end: 1 }, 0],
				["exitField", rootKey],
			];
			testDeltaVisit(delta, expected, index);
			assert.deepEqual([...index.ranges()], []);
		});

		it("when the refreshed tree already exists in the forest", () => {
			const index = makeDetachedFieldIndex("");
			const node = { minor: 42 };
			index.createRange(node, undefined);
			const rootFieldDelta: DeltaFieldChanges = { marks: [{ count: 1, attach: node }] };
			const delta: DeltaRoot = {
				refreshers: [{ id: node, trees: chunkX }],
				fields: new Map([[rootKey, rootFieldDelta]]),
			};
			const expected: VisitScript = [
				["enterField", rootKey],
				["exitField", rootKey],
				["enterField", rootKey],
				["attach", field0, { start: 0, end: 1 }, 0],
				["exitField", rootKey],
			];
			testDeltaVisit(delta, expected, index);
			assert.deepEqual([...index.ranges()], []);
		});

		it("when the refreshed tree is included in the builds", () => {
			const index = makeDetachedFieldIndex("");
			const node = { minor: 42 };
			const rootFieldDelta: DeltaFieldChanges = { marks: [{ count: 1, attach: node }] };
			const delta: DeltaRoot = {
				build: [{ id: node, trees: chunkX }],
				refreshers: [{ id: node, trees: chunkX }],
				fields: new Map([[rootKey, rootFieldDelta]]),
			};
			const expected: VisitScript = [
				["create", mapTreeX, field0],
				["enterField", rootKey],
				["exitField", rootKey],
				["enterField", rootKey],
				["attach", field0, { start: 0, end: 1 }, 0],
				["exitField", rootKey],
			];
			testDeltaVisit(delta, expected, index);
			assert.deepEqual([...index.ranges()], []);
		});
	});

	describe("rename chains", () => {
		const pointA = { minor: 1 };
		for (const cycle of [false, true]) {
			describe(cycle ? "cyclic" : "acyclic", () => {
				const end = cycle ? pointA : { minor: 42 };
				describe("1-step", () => {
					it("Rename ordering: 1/1", () => {
						const index = makeDetachedFieldIndex("");
						index.createRange(pointA, undefined);
						const rename: DeltaDetachedNodeRename = {
							count: 1,
							oldId: pointA,
							newId: end,
						};
						const delta = {
							rename: [rename],
						};
						const expected: VisitScript = cycle
							? []
							: [
									["enterField", field0],
									["detach", { start: 0, end: 1 }, field1, end, false],
									["exitField", field0],
								];
						testDeltaVisit(delta, expected, index);
						assert.deepEqual([...singletonFields(index)], [{ id: end, root: cycle ? 0 : 1 }]);
					});
				});
				describe("2-step", () => {
					for (let ordering = 1; ordering <= 2; ordering++) {
						it(`Rename ordering: ${ordering}/2`, () => {
							const index = makeDetachedFieldIndex("");
							index.createRange(pointA, undefined);
							const pointB = { minor: 2 };
							const rename1: DeltaDetachedNodeRename = {
								count: 1,
								oldId: pointA,
								newId: pointB,
							};
							const rename2: DeltaDetachedNodeRename = {
								count: 1,
								oldId: pointB,
								newId: cycle ? pointA : end,
							};
							const delta = {
								rename: [
									[rename1, rename2],
									[rename2, rename1],
								][ordering - 1],
							};
							const expected: VisitScript = [
								["enterField", field0],
								["detach", { start: 0, end: 1 }, field1, pointB, false],
								["exitField", field0],
								["enterField", field1],
								["detach", { start: 0, end: 1 }, field2, end, false],
								["exitField", field1],
							];
							testDeltaVisit(delta, expected, index);
							assert.deepEqual([...singletonFields(index)], [{ id: end, root: 2 }]);
						});
					}
				});
				describe("3-step", () => {
					for (let ordering = 1; ordering <= 6; ordering++) {
						it(`Rename ordering: ${ordering}/6`, () => {
							const pointB = { minor: 2 };
							const pointC = { minor: 3 };
							const ab: DeltaDetachedNodeRename = {
								count: 1,
								oldId: pointA,
								newId: pointB,
							};
							const bc: DeltaDetachedNodeRename = {
								count: 1,
								oldId: pointB,
								newId: pointC,
							};
							const cd: DeltaDetachedNodeRename = {
								count: 1,
								oldId: pointC,
								newId: end,
							};
							const delta = {
								rename: [
									[ab, bc, cd],
									[ab, cd, bc],
									[bc, ab, cd],
									[bc, cd, ab],
									[cd, ab, bc],
									[cd, bc, ab],
								][ordering - 1],
							};
							const expected: VisitScript = [
								["enterField", field0],
								["detach", { start: 0, end: 1 }, field1, pointB, false],
								["exitField", field0],
								["enterField", field1],
								["detach", { start: 0, end: 1 }, field2, pointC, false],
								["exitField", field1],
								["enterField", field2],
								["detach", { start: 0, end: 1 }, field3, end, false],
								["exitField", field2],
							];
							const index = makeDetachedFieldIndex("");
							index.createRange(pointA, undefined);
							testDeltaVisit(delta, expected, index);
							assert.deepEqual([...singletonFields(index)], [{ id: end, root: 3 }]);
						});
					}
				});
			});
		}
	});
});
