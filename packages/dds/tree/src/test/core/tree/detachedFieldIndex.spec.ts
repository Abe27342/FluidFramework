/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";
import path from "node:path";

import type { IIdCompressor } from "@fluidframework/id-compressor";
import {
	createIdCompressor,
	SerializationVersion,
} from "@fluidframework/id-compressor/internal";

import {
	FluidClientVersion,
	FormatValidatorNoOp,
	type CodecWriteOptions,
} from "../../../codec/index.js";
import {
	DetachedFieldIndex,
	expandDetachedFieldRanges,
	type ForestRootId,
	makeDetachedFieldIndex,
	makeDetachedNodeId,
	type RevisionTag,
	RevisionTagCodec,
} from "../../../core/index.js";
import {
	detachedFieldIndexCodecBuilder,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../core/tree/detachedFieldIndexCodecs.js";
// eslint-disable-next-line import-x/no-internal-modules
import { DetachedFieldIndexFormatVersion } from "../../../core/tree/detachedFieldIndexFormatCommon.js";
// eslint-disable-next-line import-x/no-internal-modules
import type { FormatV1 } from "../../../core/tree/detachedFieldIndexFormatV1.js";
// eslint-disable-next-line import-x/no-internal-modules
import type { FormatV2 } from "../../../core/tree/detachedFieldIndexFormatV2.js";
// eslint-disable-next-line import-x/no-internal-modules
import type { DetachedFieldSummaryData } from "../../../core/tree/detachedFieldIndexTypes.js";
import { FormatValidatorBasic } from "../../../external-utilities/index.js";
import {
	type IdAllocator,
	type JsonCompatibleReadOnly,
	brand,
	idAllocatorFromMaxId,
} from "../../../util/index.js";
import { takeJsonSnapshot, useSnapshotDirectory } from "../../snapshots/index.js";
import {
	testIdCompressor,
	testRevisionTagCodec,
	createSnapshotCompressor,
	assertIsSessionId,
	mintRevisionTag,
} from "../../utils.js";

const mintedTag = testIdCompressor.generateCompressedId();
const finalizedTag = testIdCompressor.normalizeToOpSpace(mintedTag);

const unfinalizedIdCompressor = createIdCompressor(
	assertIsSessionId("00000000-0000-4000-b000-000000000000"),
	SerializationVersion.V3,
);

const malformedData: readonly [string, JsonCompatibleReadOnly][] = [
	[
		"missing data",
		{
			version: 1,
			maxId: -1,
		},
	],
	[
		"incorrect version",
		{
			version: 999,
			data: [],
			maxId: -1,
		},
	],
	[
		"additional piece of data in entry",
		{
			version: 1,
			data: [[1, 2, 3, 4]],
			maxId: -1,
		},
	],
	[
		"incorrect data type",
		{
			version: 1,
			data: "incorrect data type",
			maxId: -1,
		},
	],
	[
		"a string",
		JSON.stringify({
			version: 1,
			data: [],
			maxId: -1,
		}),
	],
];

const validV1Data: readonly [string, FormatV1][] = [
	[
		"empty data",
		{
			version: brand(DetachedFieldIndexFormatVersion.v1),
			data: [],
			maxId: brand(-1),
		},
	],
	[
		"revision with a single entry",
		{
			version: brand(DetachedFieldIndexFormatVersion.v1),
			data: [[brand(finalizedTag), 0, brand(1)]],
			maxId: brand(-1),
		},
	],
	[
		"revision with multiple entries",
		{
			version: brand(DetachedFieldIndexFormatVersion.v1),
			data: [
				[
					brand(finalizedTag),
					[
						[1, brand(0)],
						[0, brand(1)],
					],
				],
			],
			maxId: brand(-1),
		},
	],
];
const validV2Data: readonly [string, FormatV2][] = [
	...validV1Data.map(([name, data]): [string, FormatV2] => [
		name,
		{ ...data, version: brand(DetachedFieldIndexFormatVersion.v2) },
	]),
	[
		"revision represented as a StableId",
		{
			version: brand(DetachedFieldIndexFormatVersion.v2),
			data: [[testIdCompressor.decompress(mintedTag), 0, brand(1)]],
			maxId: brand(-1),
		},
	],
];
const validData = new Map<number, readonly [string, FormatV1 | FormatV2][]>([
	[1, validV1Data],
	[2, validV2Data],
]);

interface TestCase {
	readonly name: string;
	readonly data: DetachedFieldSummaryData;
	/** The set of versions that this test case is valid for */
	readonly validFor?: ReadonlySet<number | string>;
	/** The id compressor to use for this test case */
	readonly idCompressor: IIdCompressor;
}

function generateTestCases(
	finalizedCompressor: IIdCompressor,
	unfinalizedCompressor: IIdCompressor,
): TestCase[] {
	const finalizedRevision = finalizedCompressor.generateCompressedId();
	const unfinalizedRevision = unfinalizedCompressor.generateCompressedId();
	const maxId: ForestRootId = brand(42);
	return [
		{
			name: "empty",
			data: {
				maxId,
				data: new Map(),
			},
			idCompressor: finalizedCompressor,
		},
		{
			name: "single range with single node",
			data: {
				maxId,
				data: new Map([[finalizedRevision, new Map([[0, { root: 1 }]])]]),
			},
			idCompressor: finalizedCompressor,
		},
		{
			name: "multiple nodes that do not form a single range",
			data: {
				maxId,
				data: new Map([
					[
						finalizedRevision,
						new Map([
							[2, { root: 1 }],
							[0, { root: 2 }],
							[1, { root: 4 }],
						]),
					],
				]),
			},
			idCompressor: finalizedCompressor,
		},
		{
			name: "multiple nodes that form ranges",
			data: {
				maxId,
				data: new Map([
					[
						finalizedRevision,
						new Map([
							[1, { root: 2 }],
							[3, { root: 4 }],
							[2, { root: 3 }],
							[7, { root: 6 }],
							[6, { root: 5 }],
						]),
					],
				]),
			},
			idCompressor: finalizedCompressor,
		},
		{
			name: "Unfinalized id",
			validFor: new Set([
				DetachedFieldIndexFormatVersion.v2,
				DetachedFieldIndexFormatVersion.vRangeExperimental,
			]),
			data: {
				maxId,
				data: new Map([[unfinalizedRevision, new Map([[0, { root: brand(1) }]])]]),
			},
			idCompressor: unfinalizedCompressor,
		},
	];
}

const defaultCodecWriteOptions: CodecWriteOptions = {
	jsonValidator: FormatValidatorBasic,
	minVersionForCollab: FluidClientVersion.v2_0,
};

function makeDetachedFieldIndexCodec(
	idCompressor: IIdCompressor = testIdCompressor,
	options: CodecWriteOptions = defaultCodecWriteOptions,
) {
	return detachedFieldIndexCodecBuilder.build({
		...options,
		revisionTagCodec: new RevisionTagCodec(idCompressor),
		idCompressor,
	});
}

describe("DetachedFieldIndex Codecs", () => {
	it("encodes with a version stamp.", () => {
		const detachedFieldIndex = new DetachedFieldIndex(
			"test",
			idAllocatorFromMaxId() as IdAllocator<ForestRootId>,
		);
		const expected = {
			version: 1,
			data: [],
			maxId: -1,
		};
		const codec = makeDetachedFieldIndexCodec();
		const data = detachedFieldIndex.getSummaryData();
		const encoded = codec.encode(data);
		assert.deepEqual(encoded, expected);
	});

	describe("round-trip through JSON", () => {
		for (const { name, data, idCompressor, validFor } of generateTestCases(
			testIdCompressor,
			unfinalizedIdCompressor,
		)) {
			describe(name, () => {
				for (const codec of detachedFieldIndexCodecBuilder.registry.values()) {
					if (
						validFor !== undefined &&
						codec.formatVersion !== undefined &&
						!validFor.has(codec.formatVersion)
					) {
						continue;
					}
					it(`version ${codec.formatVersion}`, () => {
						const inner = codec.codec({
							...defaultCodecWriteOptions,
							revisionTagCodec: new RevisionTagCodec(idCompressor),
							idCompressor,
						});
						const encoded = inner.encode(data);
						const decoded = inner.decode(encoded);
						assert.deepEqual(decoded, data);
					});
				}
			});
		}
	});
	describe("loadData", () => {
		const codec = detachedFieldIndexCodecBuilder.build({
			...defaultCodecWriteOptions,
			revisionTagCodec: testRevisionTagCodec,
			idCompressor: testIdCompressor,
		});
		for (const [version, cases] of validData) {
			describe(`accepts correct version ${version} data`, () => {
				for (const [name, data] of cases) {
					it(name, () => {
						codec.decode(data);
					});
				}
			});
		}
		describe("throws on receiving malformed data", () => {
			for (const [name, data] of malformedData) {
				it(name, () => {
					assert.throws(
						() => codec.decode(data),
						"Expected malformed data to throw an error on decode, but it did not.",
					);
				});
			}
		});
	});
	describe("Snapshots", () => {
		const snapshotIdCompressor = createSnapshotCompressor();
		for (const { name, data, idCompressor, validFor } of generateTestCases(
			snapshotIdCompressor,
			unfinalizedIdCompressor,
		)) {
			describe(name, () => {
				for (const format of detachedFieldIndexCodecBuilder.registry) {
					const version = format.formatVersion;
					if (validFor !== undefined && version !== undefined && !validFor.has(version)) {
						continue;
					}
					const dir = path.join("detached-field-index", name);
					useSnapshotDirectory(dir);
					it(`version ${version}`, () => {
						const codec = format.codec({
							...defaultCodecWriteOptions,
							revisionTagCodec: new RevisionTagCodec(idCompressor),
							idCompressor,
						});
						const encoded = codec.encode(data);
						takeJsonSnapshot(encoded);
					});
				}
			});
		}
	});
});

describe("expandDetachedFieldRanges", () => {
	it("projects empty and singleton fields without adding undefined revisions", () => {
		const index = makeDetachedFieldIndex();
		assert.deepEqual([...expandDetachedFieldRanges(index.ranges())], []);
		const revision = mintRevisionTag();
		const first = makeDetachedNodeId(undefined, 0);
		const second = makeDetachedNodeId(revision, 1);
		const firstRoot = index.createRange(first, undefined);
		const secondRoot = index.createRange(second, revision);
		assert.deepEqual(
			[...expandDetachedFieldRanges(index.ranges())],
			[
				{ id: first, root: firstRoot, index: 0 },
				{ id: second, root: secondRoot, index: 0, latestRelevantRevision: revision },
			],
		);
	});

	it("preserves IDs, offsets, and lifetimes when expanding fragmented grouped fields", () => {
		const index = makeDetachedFieldIndex();
		const revision = mintRevisionTag();
		const laterRevision = mintRevisionTag();
		const root = index.createRange(makeDetachedNodeId(revision, 10), revision, 5);
		index.updateLatestRevision(makeDetachedNodeId(revision, 12), laterRevision);
		index.deleteRange(root, { start: 1, end: 2 });
		const otherRoot = index.createRange(makeDetachedNodeId(undefined, 20), undefined, 2);
		const ranges = [...index.ranges()];
		assert.deepEqual(
			[...expandDetachedFieldRanges(ranges)],
			[
				{
					id: makeDetachedNodeId(revision, 10),
					root,
					index: 0,
					latestRelevantRevision: revision,
				},
				{
					id: makeDetachedNodeId(revision, 12),
					root,
					index: 1,
					latestRelevantRevision: laterRevision,
				},
				{
					id: makeDetachedNodeId(revision, 13),
					root,
					index: 2,
					latestRelevantRevision: revision,
				},
				{
					id: makeDetachedNodeId(revision, 14),
					root,
					index: 3,
					latestRelevantRevision: revision,
				},
				{ id: makeDetachedNodeId(undefined, 20), root: otherRoot, index: 0 },
				{ id: makeDetachedNodeId(undefined, 21), root: otherRoot, index: 1 },
			],
		);
		assert.deepEqual([...index.ranges()], ranges);
	});

	it("allows scalar mutation consumers to retain IDs and resolve shifted locations again", () => {
		const index = makeDetachedFieldIndex();
		index.createRange(makeDetachedNodeId(undefined, 10), undefined, 4);
		const ids = [...expandDetachedFieldRanges(index.ranges())].map(({ id }) => id);
		for (const id of ids) {
			const location = index.getLocation(id);
			assert.equal(location.index, 0);
			index.deleteRange(location.root, {
				start: location.index,
				end: location.index + 1,
			});
		}
		assert.deepEqual([...index.ranges()], []);
	});
});

describe("DetachedFieldIndex methods", () => {
	describe("experimental range persistence", () => {
		const options: CodecWriteOptions = {
			...defaultCodecWriteOptions,
			writeVersionOverrides: new Map([
				[
					detachedFieldIndexCodecBuilder.name,
					DetachedFieldIndexFormatVersion.vRangeExperimental,
				],
			]),
			allowPossiblyIncompatibleWriteVersionOverrides: true,
		};

		function createFragmentedIndex(): DetachedFieldIndex {
			const index = makeDetachedFieldIndex("Grouped");
			const root = index.createRange(makeDetachedNodeId("root", 10), mintRevisionTag(), 8);
			index.updateLatestRevision(makeDetachedNodeId("root", 12), mintRevisionTag(), 2);
			index.deleteRange(root, { start: 3, end: 5 });
			return index;
		}

		it("requires an explicit compatibility acknowledgment to select experimental writing", () => {
			const data = makeDetachedFieldIndex().getSummaryData();
			for (const [minVersionForCollab, version] of [
				[FluidClientVersion.v2_0, 1],
				[FluidClientVersion.v2_74, 2],
			] as const) {
				const codec = makeDetachedFieldIndexCodec(testIdCompressor, {
					...defaultCodecWriteOptions,
					minVersionForCollab,
				});
				assert.deepEqual(codec.encode(data), { version, data: [], maxId: -1 });
			}
			assert.throws(
				() =>
					makeDetachedFieldIndexCodec(testIdCompressor, {
						...options,
						allowPossiblyIncompatibleWriteVersionOverrides: false,
					}),
				/allowPossiblyIncompatibleWriteVersionOverrides/,
			);
			assert.deepEqual(makeDetachedFieldIndexCodec(testIdCompressor, options).encode(data), {
				version: DetachedFieldIndexFormatVersion.vRangeExperimental,
				data: [],
				maxId: -1,
			});
		});

		describe("Snapshots", () => {
			useSnapshotDirectory("detached-field-index/ranges");
			it("middle deletion and mixed lifetimes", () => {
				const codec = makeDetachedFieldIndexCodec(testIdCompressor, options);
				const encoded = codec.encode(createFragmentedIndex().getSummaryData());
				assert.deepEqual(encoded, {
					version: DetachedFieldIndexFormatVersion.vRangeExperimental,
					data: [
						[
							"root",
							[
								[10, 0, 0, 3],
								[15, 0, 3, 3],
							],
						],
					],
					maxId: 0,
				});
				takeJsonSnapshot(encoded);
			});
		});

		it("loads ranges with a default reader without enabling experimental writing", () => {
			const original = createFragmentedIndex();
			const experimental = makeDetachedFieldIndexCodec(testIdCompressor, options);
			const stable = makeDetachedFieldIndexCodec();
			const decoded = stable.decode(experimental.encode(original.getSummaryData()));
			const index = makeDetachedFieldIndex();
			const beforeLoading = index.createCheckpoint();
			index.loadData(decoded);
			assert.deepEqual(index.getSummaryData(), original.getSummaryData());
			assert.deepEqual(
				[...index.ranges()],
				[
					{ id: makeDetachedNodeId("root", 10), root: 0, index: 0, count: 3 },
					{ id: makeDetachedNodeId("root", 15), root: 0, index: 3, count: 3 },
				],
			);
			assert.deepEqual(index.getLocation(makeDetachedNodeId("root", 17)), {
				root: 0,
				index: 5,
			});
			for (const minVersionForCollab of [FluidClientVersion.v2_0, FluidClientVersion.v2_74]) {
				assert.throws(
					() =>
						makeDetachedFieldIndexCodec(testIdCompressor, {
							...defaultCodecWriteOptions,
							minVersionForCollab,
						}).encode(index.getSummaryData()),
					/Legacy detached field formats cannot encode grouped fields/,
				);
			}
			const clone = index.clone();
			const restore = index.createCheckpoint();
			const latestRevision = mintRevisionTag();
			for (const loaded of [index, clone]) {
				assert.deepEqual(loaded.getFirst(makeDetachedNodeId("root", 15), 3), {
					value: { root: 0, index: 3 },
					length: 3,
				});
				loaded.setRevisionsForLoadedData(latestRevision);
				assert.deepEqual(
					[...loaded.getRangesLastTouchedByRevision(latestRevision)],
					[
						{ id: makeDetachedNodeId("root", 10), count: 3 },
						{ id: makeDetachedNodeId("root", 15), count: 3 },
					],
				);
				assert.throws(() => loaded.setRevisionsForLoadedData(latestRevision));
				assert.equal(loaded.createRange(makeDetachedNodeId("root", 30), latestRevision, 2), 1);
			}
			const location = clone.getLocation(makeDetachedNodeId("root", 15));
			clone.deleteRange(location.root, { start: location.index, end: location.index + 2 });
			assert.deepEqual(clone.getLocation(makeDetachedNodeId("root", 17)), {
				root: 0,
				index: 3,
			});
			assert.deepEqual(index.getLocation(makeDetachedNodeId("root", 17)), {
				root: 0,
				index: 5,
			});
			restore();
			assert.deepEqual(index.getSummaryData(), decoded);
			index.setRevisionsForLoadedData(latestRevision);
			beforeLoading();
			assert.deepEqual([...index.ranges()], []);
			assert.equal(index.createRange(makeDetachedNodeId("root", 30), undefined, 2), 0);
			assert.deepEqual(index.getLocation(makeDetachedNodeId("root", 31)), {
				root: 0,
				index: 1,
			});
		});

		it("persists a million nodes as one record despite lifetime boundaries", () => {
			const index = makeDetachedFieldIndex("Grouped");
			index.createRange(makeDetachedNodeId("root", 0), mintRevisionTag(), 1_000_000);
			index.updateLatestRevision(makeDetachedNodeId("root", 10), mintRevisionTag(), 100);
			const codec = makeDetachedFieldIndexCodec(testIdCompressor, options);
			const encoded = codec.encode(index.getSummaryData());
			assert.deepEqual(encoded, {
				version: DetachedFieldIndexFormatVersion.vRangeExperimental,
				data: [["root", [[0, 0, 0, 1_000_000]]]],
				maxId: 0,
			});
			const loaded = makeDetachedFieldIndex();
			loaded.loadData(codec.decode(encoded));
			assert.equal([...loaded.ranges()].length, 1);
			assert.deepEqual(loaded.getLocation(makeDetachedNodeId("root", 999_999)), {
				root: 0,
				index: 999_999,
			});
			assert.equal(loaded.createRange(makeDetachedNodeId("root", 1_000_000)), 1);
		});

		it("validates legacy-shaped singleton bounds before writing the experimental format", () => {
			const data: DetachedFieldSummaryData = {
				maxId: brand(0),
				data: new Map([["root", new Map([[0, { root: brand(1) }]])]]),
			};
			const stable = makeDetachedFieldIndexCodec();
			const decoded = stable.decode(stable.encode(data));
			assert.doesNotThrow(() => makeDetachedFieldIndex().loadData(decoded));
			for (const jsonValidator of [FormatValidatorBasic, FormatValidatorNoOp]) {
				const codec = makeDetachedFieldIndexCodec(testIdCompressor, {
					...options,
					jsonValidator,
				});
				assert.throws(() => codec.encode(decoded), /Invalid detached field range bounds/);
				const valid = { ...decoded, maxId: brand<ForestRootId>(1) };
				assert.deepEqual(codec.decode(codec.encode(valid)), valid);
				assert.throws(
					() => codec.encode({ data: new Map(), maxId: brand(-2) }),
					/Invalid detached field range bounds/,
				);
			}
		});

		it("rejects null range metadata even without schema validation", () => {
			const codec = makeDetachedFieldIndexCodec(testIdCompressor, {
				...options,
				jsonValidator: FormatValidatorNoOp,
			});
			for (const [index, count] of [
				[null, 1],
				[0, null],
				[null, null],
			]) {
				assert.throws(
					() =>
						codec.decode({
							version: DetachedFieldIndexFormatVersion.vRangeExperimental,
							data: [["root", [[0, 0, index, count]]]],
							maxId: 0,
						}),
					/Invalid detached field range bounds/,
				);
			}
		});

		const malformedRanges: readonly [string, number[][]][] = [
			[
				"overlapping detached node IDs",
				[
					[0, 0, 0, 3],
					[2, 1, 0, 2],
				],
			],
			[
				"duplicate detached node IDs",
				[
					[0, 0, 0, 2],
					[0, 1, 0, 2],
				],
			],
			[
				"overlapping field intervals",
				[
					[0, 0, 0, 3],
					[5, 0, 2, 2],
				],
			],
			[
				"duplicate field intervals",
				[
					[0, 0, 0, 2],
					[5, 0, 0, 2],
				],
			],
			[
				"field gap",
				[
					[0, 0, 0, 2],
					[5, 0, 3, 2],
				],
			],
			["nonzero first node index", [[0, 0, 1, 2]]],
			["zero count", [[0, 0, 0, 0]]],
			["negative count", [[0, 0, 0, -1]]],
			["fractional count", [[0, 0, 0, 1.5]]],
			["negative node index", [[0, 0, -1, 1]]],
			["forest field ID beyond maxId", [[0, 2, 0, 1]]],
			["unsafe detached node ID", [[Number.MAX_SAFE_INTEGER + 1, 0, 0, 1]]],
			["detached node ID overflow", [[Number.MAX_SAFE_INTEGER, 0, 0, 2]]],
			["node index overflow", [[0, 0, 1, Number.MAX_SAFE_INTEGER]]],
		];
		for (const [name, entries] of malformedRanges) {
			it(`rejects ${name}`, () => {
				assert.throws(() =>
					makeDetachedFieldIndexCodec().decode({
						version: DetachedFieldIndexFormatVersion.vRangeExperimental,
						data: [["root", entries]],
						maxId: 1,
					}),
				);
			});
		}

		it("rejects repeated majors and fields shared between majors", () => {
			const major = testIdCompressor.normalizeToOpSpace(mintedTag);
			for (const secondMajor of ["root", major]) {
				assert.throws(() =>
					makeDetachedFieldIndexCodec().decode({
						version: DetachedFieldIndexFormatVersion.vRangeExperimental,
						data: [
							["root", [[0, 0, 0, 2]]],
							[secondMajor, [[5, 0, 2, 2]]],
						],
						maxId: 0,
					}),
				);
			}
		});

		it("validates before replacing loaded data", () => {
			const index = createFragmentedIndex();
			const before = index.getSummaryData();
			assert.throws(() =>
				index.loadData({
					maxId: brand(0),
					data: new Map([["root", new Map([[0, { root: brand(0), index: 1, count: 2 }]])]]),
				}),
			);
			assert.deepEqual(index.getSummaryData(), before);
		});
	});

	describe("enumeration order", () => {
		function assertOrder(
			index: DetachedFieldIndex,
			expected: readonly (readonly [
				major: RevisionTag | undefined,
				minors: readonly number[],
			])[],
		): void {
			assert.deepEqual(
				[...index.getSummaryData().data].map(([major, entries]) => [
					major,
					[...entries.keys()],
				]),
				expected,
			);
			assert.deepEqual(
				[...expandDetachedFieldRanges(index.ranges())].map((entry) => entry.id),
				expected.flatMap(([major, minors]) =>
					minors.map((minor) => makeDetachedNodeId(major, minor)),
				),
			);
		}

		it("retains a major's position until its last field is removed", () => {
			const index = makeDetachedFieldIndex();
			const majorA = mintRevisionTag();
			const majorB = mintRevisionTag();
			const a0 = makeDetachedNodeId(majorA, 0);
			const a1 = makeDetachedNodeId(majorA, 1);
			const a2 = makeDetachedNodeId(majorA, 2);
			index.createRange(a0, undefined);
			index.createRange(makeDetachedNodeId(majorB, 0), undefined);
			index.createRange(a2, undefined);
			index.createRange(a1, undefined);
			index.deleteRange(index.getLocation(a0).root, { start: 0, end: 1 });
			assertOrder(index, [
				[majorA, [2, 1]],
				[majorB, [0]],
			]);

			index.updateLatestRevision(a2, majorB);
			index.updateLatestRevision(a1, majorB);
			assertOrder(index, [
				[majorA, [2, 1]],
				[majorB, [0]],
			]);

			index.deleteRange(index.getLocation(a2).root, { start: 0, end: 1 });
			index.createRange(a2, undefined);
			assertOrder(index, [
				[majorA, [1, 2]],
				[majorB, [0]],
			]);
			index.deleteRange(index.getLocation(a1).root, { start: 0, end: 1 });
			index.deleteRange(index.getLocation(a2).root, { start: 0, end: 1 });
			index.createRange(a0, undefined);
			assertOrder(index, [
				[majorB, [0]],
				[majorA, [0]],
			]);
		});

		it("preserves major and minor order through clone, checkpoint, and load", () => {
			const index = makeDetachedFieldIndex();
			const major = mintRevisionTag();
			const a0 = makeDetachedNodeId(major, 0);
			const a1 = makeDetachedNodeId(major, 1);
			const a3 = makeDetachedNodeId(major, 3);
			index.createRange(a0, undefined);
			index.createRange(makeDetachedNodeId(undefined, 4), undefined);
			index.createRange(a3, undefined);
			index.createRange(a1, undefined);
			index.deleteRange(index.getLocation(a0).root, { start: 0, end: 1 });
			const expected = [
				[major, [3, 1]],
				[undefined, [4]],
			] as const;
			const clone = index.clone();
			assertOrder(clone, expected);
			clone.deleteRange(clone.getLocation(a3).root, { start: 0, end: 1 });
			clone.createRange(a3, undefined);
			assertOrder(clone, [
				[major, [1, 3]],
				[undefined, [4]],
			]);
			assertOrder(index, expected);

			const restore = index.createCheckpoint();
			for (let attempt = 0; attempt < 2; attempt++) {
				index.deleteRange(index.getLocation(a3).root, { start: 0, end: 1 });
				index.deleteRange(index.getLocation(a1).root, { start: 0, end: 1 });
				index.createRange(a0, undefined);
				assertOrder(index, [
					[undefined, [4]],
					[major, [0]],
				]);
				restore();
				assertOrder(index, expected);
			}

			const loaded = makeDetachedFieldIndex();
			loaded.createRange(makeDetachedNodeId(mintRevisionTag(), 0), undefined);
			loaded.loadData(index.getSummaryData());
			assertOrder(loaded, expected);
			loaded.setRevisionsForLoadedData(mintRevisionTag());
			assertOrder(loaded, expected);
		});

		it("preserves order for compact grouped fields through fragmentation and consumption", () => {
			const index = makeDetachedFieldIndex("Grouped");
			const majorA = mintRevisionTag();
			const majorB = mintRevisionTag();
			const first = index.createRange(makeDetachedNodeId(majorA, 0), undefined, 2);
			const other = index.createRange(makeDetachedNodeId(majorB, 0), undefined, 1);
			const grouped = index.createRange(makeDetachedNodeId(majorA, 10), undefined, 1_000_000);
			index.deleteRange(first, { start: 0, end: 2 });
			assert.deepEqual(
				[...index.ranges()].map((record) => record.root),
				[grouped, other],
			);
			index.updateLatestRevision(makeDetachedNodeId(majorA, 110), majorB, 200);
			assert.deepEqual(
				[...index.clone().ranges()].map((record) => record.root),
				[grouped, grouped, grouped, other],
			);
			index.deleteRange(grouped, { start: 0, end: 999_999 });
			assertOrder(index, [
				[majorA, [1_000_009]],
				[majorB, [0]],
			]);
			index.purge();
			index.createRange(makeDetachedNodeId(majorB, 0), undefined, 1);
			index.createRange(makeDetachedNodeId(majorA, 0), undefined, 1);
			assertOrder(index, [
				[majorB, [0]],
				[majorA, [0]],
			]);
		});
	});

	describe("range operations", () => {
		it("supports grouped fields without a constructor mode", () => {
			for (const index of [
				makeDetachedFieldIndex(),
				new DetachedFieldIndex("Grouped", idAllocatorFromMaxId() as IdAllocator<ForestRootId>),
			]) {
				const id = makeDetachedNodeId(undefined, 0);
				const root = index.createRange(id, undefined, 3);
				assert.deepEqual(index.getFirst(id, 3), {
					value: { root, index: 0 },
					length: 3,
				});
				assert.deepEqual(index.clone().getLocation(makeDetachedNodeId(undefined, 2)), {
					root,
					index: 2,
				});
				assert.equal(index.createRange(makeDetachedNodeId(undefined, 3), undefined), root + 1);
			}
		});

		it("represents a million nodes as one record and allocates only one field", () => {
			const index = makeDetachedFieldIndex("Grouped");
			const revision = mintRevisionTag();
			const id = makeDetachedNodeId(revision, 10);
			const count = 1_000_000;
			const root = index.createRange(id, revision, count);
			assert.deepEqual(
				[...index.ranges()],
				[{ id, count, root, index: 0, latestRelevantRevision: revision }],
			);
			for (const offset of [0, 123_456, count - 1]) {
				const queryId = makeDetachedNodeId(revision, id.minor + offset);
				assert.deepEqual(index.getLocation(queryId), { root, index: offset });
				assert.deepEqual(index.getFirst(queryId, count), {
					value: { root, index: offset },
					length: count - offset,
				});
			}
			assert.equal(index.tryGetLocation(makeDetachedNodeId(revision, 9)), undefined);
			assert.equal(
				index.tryGetLocation(makeDetachedNodeId(revision, id.minor + count)),
				undefined,
			);
			assert.deepEqual(index.getFieldRanges(root, { start: 0, end: count }), [{ id, count }]);
			assert.deepEqual([...index.getRangesLastTouchedByRevision(revision)], [{ id, count }]);
			assert.equal(
				index.createRange(makeDetachedNodeId(revision, id.minor + count), revision),
				root + 1,
			);
		});

		it("finds missing prefixes in detached node ID order without crossing major or forest field boundaries", () => {
			const index = makeDetachedFieldIndex("Grouped");
			const major = mintRevisionTag();
			const otherMajor = mintRevisionTag();
			index.createRange(makeDetachedNodeId(major, 100), undefined, 5);
			const root = index.createRange(makeDetachedNodeId(major, 10), undefined, 3);
			index.createRange(makeDetachedNodeId(otherMajor, 0), undefined, 500);
			index.createRange(makeDetachedNodeId(undefined, 5), undefined, 5);
			for (const count of [
				0,
				-1,
				0.5,
				Number.POSITIVE_INFINITY,
				Number.NaN,
				Number.MAX_SAFE_INTEGER + 1,
			]) {
				for (const minor of [0, 10]) {
					assert.throws(() => index.getFirst(makeDetachedNodeId(major, minor), count));
				}
			}
			assert.deepEqual(index.getFirst(makeDetachedNodeId(major, 0), 200), {
				value: undefined,
				length: 10,
			});
			assert.deepEqual(index.getFirst(makeDetachedNodeId(major, 13), 200), {
				value: undefined,
				length: 87,
			});
			assert.deepEqual(index.getFirst(makeDetachedNodeId(major, 13), 2), {
				value: undefined,
				length: 2,
			});
			assert.deepEqual(index.getFirst(makeDetachedNodeId(major, 105), 1_000_000), {
				value: undefined,
				length: 1_000_000,
			});
			assert.deepEqual(index.getFirst(makeDetachedNodeId(mintRevisionTag(), 0), 200), {
				value: undefined,
				length: 200,
			});
			assert.deepEqual(index.getFirst(makeDetachedNodeId(undefined, 0), 200), {
				value: undefined,
				length: 5,
			});
			index.createRange(makeDetachedNodeId(major, 13), undefined, 2);
			assert.deepEqual(index.getFirst(makeDetachedNodeId(major, 10), 5), {
				value: { root, index: 0 },
				length: 3,
			});
		});

		it("splits lifetimes without extending retention or splitting contiguous forest locations", () => {
			const index = makeDetachedFieldIndex("Grouped");
			const oldRevision = mintRevisionTag();
			const newRevision = mintRevisionTag();
			const id = makeDetachedNodeId(undefined, 0);
			const root = index.createRange(id, oldRevision, 100);
			index.updateLatestRevision(makeDetachedNodeId(undefined, 20), newRevision, 30);
			assert.deepEqual(
				[...index.ranges()].map((record) => [
					record.id.minor,
					record.count,
					record.index,
					record.latestRelevantRevision,
				]),
				[
					[0, 20, 0, oldRevision],
					[20, 30, 20, newRevision],
					[50, 50, 50, oldRevision],
				],
			);
			assert.deepEqual(
				[...index.getRangesLastTouchedByRevision(oldRevision)],
				[
					{ id, count: 20 },
					{ id: makeDetachedNodeId(undefined, 50), count: 50 },
				],
			);
			assert.deepEqual(
				[...index.getRangesLastTouchedByRevision(newRevision)],
				[{ id: makeDetachedNodeId(undefined, 20), count: 30 }],
			);
			assert.deepEqual(index.getFirst(makeDetachedNodeId(undefined, 10), 80), {
				value: { root, index: 10 },
				length: 80,
			});
			assert.deepEqual(index.getFieldRanges(root, { start: 10, end: 90 }), [
				{ id: makeDetachedNodeId(undefined, 10), count: 80 },
			]);
			index.updateLatestRevision(makeDetachedNodeId(undefined, 25), undefined);
			assert.equal([...index.ranges()].length, 5);
			assert.deepEqual(index.getFirst(id, 100), { value: { root, index: 0 }, length: 100 });
			index.updateLatestRevision(id, oldRevision, 100);
			assert.equal([...index.ranges()].length, 1);
			assert.deepEqual([...index.getRangesLastTouchedByRevision(newRevision)], []);
		});

		it("updates a detached node ID range that spans several forest fields", () => {
			const index = makeDetachedFieldIndex("Grouped");
			const oldRevision = mintRevisionTag();
			const newRevision = mintRevisionTag();
			const first = index.createRange(makeDetachedNodeId(undefined, 0), oldRevision, 5);
			const second = index.createRange(makeDetachedNodeId(undefined, 5), oldRevision, 5);
			index.updateLatestRevision(makeDetachedNodeId(undefined, 3), newRevision, 4);
			assert.deepEqual(
				[...index.getRangesLastTouchedByRevision(newRevision)],
				[
					{ id: makeDetachedNodeId(undefined, 3), count: 2 },
					{ id: makeDetachedNodeId(undefined, 5), count: 2 },
				],
			);
			assert.deepEqual(index.getLocation(makeDetachedNodeId(undefined, 3)), {
				root: first,
				index: 3,
			});
			assert.deepEqual(index.getLocation(makeDetachedNodeId(undefined, 6)), {
				root: second,
				index: 1,
			});
			assert.equal([...index.ranges()].length, 4);
		});

		it("removes forest field ranges across detached node ID runs and shifts surviving suffixes", () => {
			const index = makeDetachedFieldIndex("Grouped");
			const revision = mintRevisionTag();
			const laterRevision = mintRevisionTag();
			const root = index.createRange(makeDetachedNodeId(undefined, 0), revision, 100);
			index.deleteRange(root, { start: 20, end: 40 });
			assert.equal([...index.ranges()].length, 2);
			assert.deepEqual(index.getFieldRanges(root, { start: 10, end: 30 }), [
				{ id: makeDetachedNodeId(undefined, 10), count: 10 },
				{ id: makeDetachedNodeId(undefined, 40), count: 10 },
			]);
			assert.deepEqual(index.getLocation(makeDetachedNodeId(undefined, 40)), {
				root,
				index: 20,
			});
			assert.deepEqual(index.getLocation(makeDetachedNodeId(undefined, 99)), {
				root,
				index: 79,
			});
			assert.deepEqual(index.getFirst(makeDetachedNodeId(undefined, 20), 80), {
				value: undefined,
				length: 20,
			});
			assert.deepEqual(index.getFirst(makeDetachedNodeId(undefined, 0), 100), {
				value: { root, index: 0 },
				length: 20,
			});
			index.updateLatestRevision(makeDetachedNodeId(undefined, 50), laterRevision, 10);
			index.deleteRange(root, { start: 15, end: 45 });
			assert.deepEqual(index.getFieldRanges(root, { start: 0, end: 50 }), [
				{ id: makeDetachedNodeId(undefined, 0), count: 15 },
				{ id: makeDetachedNodeId(undefined, 65), count: 35 },
			]);
			assert.deepEqual([...index.getRangesLastTouchedByRevision(laterRevision)], []);
			assert.equal(index.tryGetLocation(makeDetachedNodeId(undefined, 64)), undefined);
			index.deleteRange(root, { start: 0, end: 50 });
			assert.deepEqual([...index.ranges()], []);
			assert.deepEqual([...index.getRangesLastTouchedByRevision(revision)], []);
			assert.throws(() => index.getFieldRanges(root, { start: 0, end: 0 }));
		});

		it("snapshots detached node ID ranges by revision while earlier ranges in the same field are consumed", () => {
			const index = makeDetachedFieldIndex("Grouped");
			const oldRevision = mintRevisionTag();
			const newRevision = mintRevisionTag();
			const root = index.createRange(makeDetachedNodeId(undefined, 0), oldRevision, 100);
			index.updateLatestRevision(makeDetachedNodeId(undefined, 20), newRevision, 20);
			index.updateLatestRevision(makeDetachedNodeId(undefined, 60), newRevision, 20);
			const snapshot = index.getRangesLastTouchedByRevision(oldRevision);
			for (const { id, count } of snapshot) {
				const location = index.getLocation(id);
				index.deleteRange(location.root, {
					start: location.index,
					end: location.index + count,
				});
			}
			assert.deepEqual(
				[...snapshot],
				[
					{ id: makeDetachedNodeId(undefined, 0), count: 20 },
					{ id: makeDetachedNodeId(undefined, 40), count: 20 },
					{ id: makeDetachedNodeId(undefined, 80), count: 20 },
				],
			);
			assert.deepEqual(index.getFieldRanges(root, { start: 0, end: 40 }), [
				{ id: makeDetachedNodeId(undefined, 20), count: 20 },
				{ id: makeDetachedNodeId(undefined, 60), count: 20 },
			]);
			assert.deepEqual([...index.getRangesLastTouchedByRevision(oldRevision)], []);
			assert.equal([...index.ranges()].length, 2);
		});

		it("clones and repeatedly restores compact independent state and allocation", () => {
			const index = makeDetachedFieldIndex("Grouped");
			const revision = mintRevisionTag();
			const laterRevision = mintRevisionTag();
			const id = makeDetachedNodeId(undefined, 0);
			const root = index.createRange(id, revision, 1_000_000);
			const restore = index.createCheckpoint();
			const clone = index.clone();
			clone.updateLatestRevision(makeDetachedNodeId(undefined, 100), laterRevision, 10);
			clone.deleteRange(root, { start: 200, end: 300 });
			assert.equal([...clone.ranges()].length, 4);
			assert.equal([...index.ranges()].length, 1);
			assert.deepEqual([...index.getRangesLastTouchedByRevision(laterRevision)], []);
			for (let attempt = 0; attempt < 2; attempt++) {
				index.deleteRange(root, { start: 0, end: 1_000_000 });
				index.createRange(makeDetachedNodeId(undefined, 2_000_000), undefined);
				restore();
				assert.deepEqual(
					[...index.ranges()],
					[{ id, root, index: 0, count: 1_000_000, latestRelevantRevision: revision }],
				);
				assert.equal(
					index.createRange(makeDetachedNodeId(undefined, 1_000_000), undefined),
					root + 1,
				);
			}
			assert.equal([...clone.ranges()].length, 4);
		});

		it("rejects overlaps, holes, and invalid forest field ranges without changing the index", () => {
			const index = makeDetachedFieldIndex("Grouped");
			const revision = mintRevisionTag();
			const id = makeDetachedNodeId(undefined, 10);
			const root = index.createRange(id, revision, 10);
			const original = [...index.ranges()];
			for (const [minor, count] of [
				[10, 10],
				[0, 11],
				[15, 20],
			]) {
				const overlap = makeDetachedNodeId(undefined, minor);
				assert.throws(() => index.createRange(overlap, revision, count));
			}
			for (const count of [0, -1, 0.5]) {
				assert.throws(() => index.createRange(id, revision, count));
			}
			assert.throws(() => index.updateLatestRevision(id, mintRevisionTag(), 11));
			assert.throws(() =>
				index.updateLatestRevision(makeDetachedNodeId(undefined, 9), mintRevisionTag(), 5),
			);
			for (const range of [
				{ start: -1, end: 1 },
				{ start: 0, end: 11 },
				{ start: 5, end: 4 },
				{ start: 0.5, end: 1 },
			]) {
				assert.throws(() => index.getFieldRanges(root, range));
				assert.throws(() => index.deleteRange(root, range));
			}
			assert.throws(() => index.getLocation(makeDetachedNodeId(undefined, 0)));
			assert.throws(() => index.getFieldRanges(brand(root + 1), { start: 0, end: 1 }));
			assert.deepEqual(index.getFieldRanges(root, { start: 10, end: 10 }), []);
			assert.deepEqual(index.getFieldRanges(root, { start: 5, end: 5 }), []);
			index.deleteRange(root, { start: 10, end: 10 });
			assert.deepEqual([...index.ranges()], original);
			assert.equal(index.createRange(makeDetachedNodeId(undefined, 20), undefined), root + 1);

			index.deleteRange(root, { start: 3, end: 7 });
			const fragmented = [...index.ranges()];
			assert.throws(() => index.updateLatestRevision(id, mintRevisionTag(), 10));
			assert.deepEqual([...index.ranges()], fragmented);
		});

		it("loads grouped summary data with independent locations and initializes lifetimes", () => {
			const index = makeDetachedFieldIndex("Grouped");
			const revision = mintRevisionTag();
			const id = makeDetachedNodeId(undefined, 0);
			const root = index.createRange(id, revision, 3);
			index.updateLatestRevision(makeDetachedNodeId(undefined, 1), undefined);
			const loaded = makeDetachedFieldIndex("Loaded");
			loaded.loadData(index.getSummaryData());
			assert.deepEqual([...loaded.ranges()], [{ id, root, index: 0, count: 3 }]);
			assert.deepEqual(loaded.getLocation(makeDetachedNodeId(undefined, 2)), {
				root,
				index: 2,
			});
			loaded.setRevisionsForLoadedData(revision);
			assert.deepEqual(
				[...loaded.getRangesLastTouchedByRevision(revision)],
				[{ id, count: 3 }],
			);
			loaded.deleteRange(root, { start: 0, end: 2 });
			assert.deepEqual(index.getLocation(makeDetachedNodeId(undefined, 2)), {
				root,
				index: 2,
			});
		});

		for (const format of detachedFieldIndexCodecBuilder.registry) {
			if (format.formatVersion !== DetachedFieldIndexFormatVersion.vRangeExperimental) {
				it(`rejects grouped fields only at legacy codec version ${format.formatVersion}`, () => {
					const index = makeDetachedFieldIndex();
					const revision = mintRevisionTag();
					const id = makeDetachedNodeId(revision, 0);
					const root = index.createRange(id, revision, 3);
					const codec = format.codec({
						...defaultCodecWriteOptions,
						revisionTagCodec: testRevisionTagCodec,
						idCompressor: testIdCompressor,
					});
					const summary = index.getSummaryData();
					assert.throws(() => codec.encode(summary));
					index.updateLatestRevision(makeDetachedNodeId(revision, 1), undefined);
					assert.throws(() => codec.encode(index.getSummaryData()));
					index.deleteRange(root, { start: 0, end: 2 });
					assert.doesNotThrow(() => codec.encode(index.getSummaryData()));
					assert.deepEqual(index.getLocation(makeDetachedNodeId(revision, 2)), {
						root,
						index: 0,
					});
				});
			}

			it(`round-trips singleton ranges through summary version ${format.formatVersion}`, () => {
				const index = makeDetachedFieldIndex("Grouped");
				const revision = mintRevisionTag();
				const id = makeDetachedNodeId(revision, 0);
				const root = index.createRange(id, revision, 1);
				const codec = format.codec({
					...defaultCodecWriteOptions,
					revisionTagCodec: testRevisionTagCodec,
					idCompressor: testIdCompressor,
				});
				const loaded = makeDetachedFieldIndex("Loaded");
				loaded.loadData(codec.decode(codec.encode(index.getSummaryData())));
				assert.deepEqual([...loaded.ranges()], [{ id, count: 1, root, index: 0 }]);
				const restore = loaded.createCheckpoint();
				const clone = loaded.clone();
				const latestRevision = mintRevisionTag();
				clone.setRevisionsForLoadedData(latestRevision);
				loaded.setRevisionsForLoadedData(latestRevision);
				assert.throws(() => loaded.setRevisionsForLoadedData(latestRevision));
				restore();
				loaded.setRevisionsForLoadedData(latestRevision);
				assert.deepEqual(
					[...loaded.getRangesLastTouchedByRevision(latestRevision)],
					[{ id, count: 1 }],
				);
				assert.equal(loaded.createRange(makeDetachedNodeId(revision, 1), undefined), root + 1);
			});
		}
	});

	describe("createRange", () => {
		it("can retrieve locations after creating", () => {
			const detachedIndex = makeDetachedFieldIndex();
			const revisionTag1 = mintRevisionTag();
			const detachedNodeId1 = makeDetachedNodeId(revisionTag1, 1);

			const revisionTag2 = mintRevisionTag();
			const rootId = detachedIndex.createRange(detachedNodeId1, revisionTag2);

			const revisionTag3 = mintRevisionTag();
			const detachedNodeId2 = makeDetachedNodeId(revisionTag3, 2);
			assert.deepEqual(detachedIndex.tryGetLocation(detachedNodeId1), {
				root: rootId,
				index: 0,
			});
			assert.deepEqual(detachedIndex.getLocation(detachedNodeId1), {
				root: rootId,
				index: 0,
			});
			assert.equal(detachedIndex.tryGetLocation(detachedNodeId2), undefined);
			assert.throws(() => detachedIndex.getLocation(detachedNodeId2));
		});

		it("creates consecutive minor IDs in one field when count > 1 is passed in", () => {
			const detachedIndex = makeDetachedFieldIndex();
			const revisionTag1 = mintRevisionTag();
			const detachedNodeId1 = makeDetachedNodeId(revisionTag1, 1);

			const revisionTag2 = mintRevisionTag();
			const root = detachedIndex.createRange(detachedNodeId1, revisionTag2, 2);
			assert.deepEqual(
				[...detachedIndex.getRangesLastTouchedByRevision(revisionTag2)],
				[{ id: detachedNodeId1, count: 2 }],
			);
			assert.deepEqual(
				[...detachedIndex.ranges()],
				[
					{
						root,
						index: 0,
						count: 2,
						latestRelevantRevision: revisionTag2,
						id: detachedNodeId1,
					},
				],
			);
			assert.deepEqual(
				detachedIndex.getLocation(makeDetachedNodeId(revisionTag1, detachedNodeId1.minor + 1)),
				{ root, index: 1 },
			);
		});
	});

	it("ranges returns all created fields", () => {
		const detachedIndex = makeDetachedFieldIndex();

		const revisionTag1 = mintRevisionTag();
		const detachedNodeId1 = makeDetachedNodeId(revisionTag1, 1);
		const detachedNodeId2 = makeDetachedNodeId(undefined, 2);

		const revisionTag2 = mintRevisionTag();
		const rootId1 = detachedIndex.createRange(detachedNodeId1, revisionTag2);
		const rootId2 = detachedIndex.createRange(detachedNodeId2, revisionTag2, 2);

		assert.deepEqual(
			[...detachedIndex.ranges()],
			[
				{
					root: rootId1,
					index: 0,
					count: 1,
					latestRelevantRevision: revisionTag2,
					id: detachedNodeId1,
				},
				{
					root: rootId2,
					index: 0,
					count: 2,
					latestRelevantRevision: revisionTag2,
					id: detachedNodeId2,
				},
			],
		);
	});

	it("removes ranges last touched by a revision without removing newer ranges", () => {
		const detachedIndex = makeDetachedFieldIndex();

		const revisionTag1 = mintRevisionTag();
		const detachedNodeId1 = makeDetachedNodeId(revisionTag1, 1);
		const detachedNodeId2 = makeDetachedNodeId(revisionTag1, 2);

		const revisionTag2 = mintRevisionTag();
		detachedIndex.createRange(detachedNodeId1, revisionTag2);
		detachedIndex.createRange(detachedNodeId2, revisionTag2, 2);

		const revisionTag3 = mintRevisionTag();
		const detachedNodeId3 = makeDetachedNodeId(revisionTag1, 4);
		const undeletedRootId = detachedIndex.createRange(detachedNodeId3, revisionTag3);

		for (const { id, count } of detachedIndex.getRangesLastTouchedByRevision(revisionTag2)) {
			const { root, index } = detachedIndex.getLocation(id);
			detachedIndex.deleteRange(root, { start: index, end: index + count });
		}
		assert.equal(detachedIndex.tryGetLocation(detachedNodeId1), undefined);
		assert.equal(detachedIndex.tryGetLocation(detachedNodeId2), undefined);
		assert.equal(detachedIndex.tryGetLocation(makeDetachedNodeId(revisionTag1, 3)), undefined);
		assert.deepEqual(detachedIndex.tryGetLocation(detachedNodeId3), {
			root: undeletedRootId,
			index: 0,
		});
	});

	it("getRangesLastTouchedByRevision returns no ranges for an unknown revision", () => {
		const detachedIndex = makeDetachedFieldIndex();
		const revisionTag1 = mintRevisionTag();
		assert.deepEqual([...detachedIndex.getRangesLastTouchedByRevision(revisionTag1)], []);
	});

	it("deleteRange removes a singleton field, and throws if the field does not exist", () => {
		const detachedIndex = makeDetachedFieldIndex();

		const revisionTag1 = mintRevisionTag();
		const detachedNodeId1 = makeDetachedNodeId(revisionTag1, 1);

		const revisionTag2 = mintRevisionTag();
		const root = detachedIndex.createRange(detachedNodeId1, revisionTag2);

		detachedIndex.deleteRange(root, { start: 0, end: 1 });
		assert.equal(detachedIndex.tryGetLocation(detachedNodeId1), undefined);
		assert.throws(() => detachedIndex.deleteRange(root, { start: 0, end: 1 }));
	});

	it("purge removes all entries", () => {
		const detachedIndex = makeDetachedFieldIndex();

		const revisionTag1 = mintRevisionTag();
		const detachedNodeId1 = makeDetachedNodeId(revisionTag1, 1);
		const detachedNodeId2 = makeDetachedNodeId(revisionTag1, 2);

		const revisionTag2 = mintRevisionTag();
		detachedIndex.createRange(detachedNodeId1, revisionTag2);
		detachedIndex.createRange(detachedNodeId2, revisionTag2, 2);

		detachedIndex.purge();
		assert.equal([...detachedIndex.ranges()].length, 0);
		assert.deepEqual([...detachedIndex.getRangesLastTouchedByRevision(revisionTag2)], []);
	});

	it("loadData preserves maxId and entries, and sets latestRelevantRevision to undefined.", () => {
		const detachedIndex = makeDetachedFieldIndex();

		const revisionTag1 = mintRevisionTag();
		const detachedNodeId = makeDetachedNodeId(revisionTag1, 1);

		const revisionTag2 = mintRevisionTag();
		const rootId = detachedIndex.createRange(detachedNodeId, revisionTag2);

		const codec = makeDetachedFieldIndexCodec();
		const encodedDetachedIndex = codec.encode(detachedIndex.getSummaryData());

		const detachedIndex2 = makeDetachedFieldIndex();
		detachedIndex2.loadData(codec.decode(encodedDetachedIndex));
		assert.deepEqual(detachedIndex2.tryGetLocation(detachedNodeId), {
			root: rootId,
			index: 0,
		});

		// Check that the summary round trip set the latestRelevantRevision to undefined.
		assert.equal([...detachedIndex2.ranges()][0].latestRelevantRevision, undefined);

		// Check that the maxId is preserved, and doesn't reset
		const nextId = detachedIndex2.createRange(makeDetachedNodeId(revisionTag1, 2), undefined);
		assert.equal(rootId + 1, nextId);
	});

	it("setRevisionsForLoadedData sets latestRelevantRevision, and throws if called more than once.", () => {
		const detachedIndex = makeDetachedFieldIndex();

		const revisionTag1 = mintRevisionTag();
		const detachedNodeId = makeDetachedNodeId(revisionTag1, 1);

		const revisionTag2 = mintRevisionTag();
		const rootId = detachedIndex.createRange(detachedNodeId, revisionTag2);

		const codec = makeDetachedFieldIndexCodec();
		const encodedDetachedIndex = codec.encode(detachedIndex.getSummaryData());

		const detachedIndex2 = makeDetachedFieldIndex();
		detachedIndex2.loadData(codec.decode(encodedDetachedIndex));
		assert.deepEqual(detachedIndex2.tryGetLocation(detachedNodeId), {
			root: rootId,
			index: 0,
		});

		// Sets the new revision tag after loading
		const revisionTag3 = mintRevisionTag();
		detachedIndex2.setRevisionsForLoadedData(revisionTag3);
		assert.equal([...detachedIndex2.ranges()][0].latestRelevantRevision, revisionTag3);
		// Check that it was last touched by revisionTag3
		assert.deepEqual(
			[...detachedIndex2.getRangesLastTouchedByRevision(revisionTag3)],
			[{ id: detachedNodeId, count: 1 }],
		);

		// Throws if setRevisionsForLoadedData is called more than once.
		assert.throws(() => detachedIndex2.setRevisionsForLoadedData(mintRevisionTag()));
	});

	describe("getRangesLastTouchedByRevision", () => {
		it("returns detached node ranges only for the new revision after calling updateLatestRevision.", () => {
			const detachedIndex = makeDetachedFieldIndex();

			const revisionTag1 = mintRevisionTag();
			const detachedNodeId = makeDetachedNodeId(revisionTag1, 1);

			const revisionTag2 = mintRevisionTag();
			detachedIndex.createRange(detachedNodeId, revisionTag2, 2);
			assert.deepEqual(
				[...detachedIndex.getRangesLastTouchedByRevision(revisionTag2)],
				[{ id: detachedNodeId, count: 2 }],
			);

			const revisionTag3 = mintRevisionTag();
			detachedIndex.updateLatestRevision(detachedNodeId, revisionTag3, 2);
			assert.deepEqual(
				[...detachedIndex.getRangesLastTouchedByRevision(revisionTag3)],
				[{ id: detachedNodeId, count: 2 }],
			);
			assert.deepEqual([...detachedIndex.getRangesLastTouchedByRevision(revisionTag2)], []);
		});
	});

	it("clone copies the maxId and detachedIndex contents, and changes to clone does not affect the original.", () => {
		const detachedIndex = makeDetachedFieldIndex();
		const revisionTag1 = mintRevisionTag();
		const detachedNodeId = makeDetachedNodeId(revisionTag1, 1);

		const revisionTag2 = mintRevisionTag();
		const rootId = detachedIndex.createRange(detachedNodeId, revisionTag2);

		const detachedIndexClone = detachedIndex.clone();
		assert.deepEqual(detachedIndexClone.tryGetLocation(detachedNodeId), {
			root: rootId,
			index: 0,
		});

		// To check if the maxId from original is preserved
		const nextId = detachedIndexClone.createRange(
			makeDetachedNodeId(revisionTag1, 2),
			undefined,
		);
		assert.equal(nextId, rootId + 1);

		// Check that changes to the clone does not affect the original
		detachedIndexClone.deleteRange(rootId, { start: 0, end: 1 });
		assert.equal(detachedIndexClone.tryGetLocation(detachedNodeId), undefined);
		assert.deepEqual(detachedIndex.tryGetLocation(detachedNodeId), {
			root: rootId,
			index: 0,
		});
	});

	it("toFieldKey created different field keys for different root ids", () => {
		const detachedIndex = makeDetachedFieldIndex();
		const revisionTag1 = mintRevisionTag();
		const detachedNodeId = makeDetachedNodeId(revisionTag1, 1);
		const detachedNodeId2 = makeDetachedNodeId(revisionTag1, 2);
		const rootId = detachedIndex.createRange(detachedNodeId, undefined);
		const rootId2 = detachedIndex.createRange(detachedNodeId2, undefined);
		assert.notEqual(detachedIndex.toFieldKey(rootId), detachedIndex.toFieldKey(rootId2));
	});

	describe("checkpoints", () => {
		it("invoking a checkpoint restores the index state", () => {
			const index = makeDetachedFieldIndex();
			const revisionTag1 = mintRevisionTag();
			const root = index.createRange(makeDetachedNodeId(revisionTag1, 1), undefined);

			const originalData = index.getSummaryData();
			const restore = index.createCheckpoint();

			// Make changes to the index
			index.deleteRange(root, { start: 0, end: 1 });
			index.createRange(makeDetachedNodeId(revisionTag1, 2), revisionTag1);
			assert.notDeepEqual(index.getSummaryData(), originalData);

			restore();
			assert.deepEqual(index.getSummaryData(), originalData);
		});

		it("multiple checkpoints can exist for the same index", () => {
			const index = makeDetachedFieldIndex();
			const revisionTag1 = mintRevisionTag();
			const root = index.createRange(makeDetachedNodeId(revisionTag1, 1), undefined);

			const originalData = index.getSummaryData();
			const restore1 = index.createCheckpoint();

			// Make changes to the index
			index.deleteRange(root, { start: 0, end: 1 });
			index.createRange(makeDetachedNodeId(revisionTag1, 2), revisionTag1);
			assert.notDeepEqual(index.getSummaryData(), originalData);

			const changedData = index.getSummaryData();
			const restore2 = index.createCheckpoint();

			restore1();
			assert.deepEqual(index.getSummaryData(), originalData);

			restore2();
			assert.deepEqual(index.getSummaryData(), changedData);
		});

		it("a checkpoint can be restored multiple times", () => {
			const index = makeDetachedFieldIndex();
			const revisionTag1 = mintRevisionTag();
			const root = index.createRange(makeDetachedNodeId(revisionTag1, 1), undefined);

			const originalData = index.getSummaryData();
			const restore = index.createCheckpoint();

			// Make changes to the index
			index.deleteRange(root, { start: 0, end: 1 });
			index.createRange(makeDetachedNodeId(revisionTag1, 2), revisionTag1);
			assert.notDeepEqual(index.getSummaryData(), originalData);

			restore();
			assert.deepEqual(index.getSummaryData(), originalData);

			// Make more changes to the index
			index.createRange(makeDetachedNodeId(revisionTag1, 3), revisionTag1);
			assert.notDeepEqual(index.getSummaryData(), originalData);

			restore();
			assert.deepEqual(index.getSummaryData(), originalData);
		});
	});
});
