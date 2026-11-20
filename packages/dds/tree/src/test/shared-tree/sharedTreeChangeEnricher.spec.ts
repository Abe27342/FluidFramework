/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import {
	type DetachedNodeRange,
	TreeStoredSchemaRepository,
	makeDetachedFieldIndex,
	rootFieldKey,
} from "../../core/index.js";
import {
	NodeMoveType,
	buildChunkedForest,
	defaultIncrementalEncodingPolicy,
	defaultSchemaPolicy,
	makeTreeChunker,
} from "../../feature-libraries/index.js";
import {
	TreeShape,
	UniformChunk,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../feature-libraries/chunked-forest/uniformChunk.js";
import {
	SharedTreeChangeEnricher,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../shared-tree/sharedTreeChangeEnricher.js";
import type {
	SharedTreeChange,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../shared-tree/sharedTreeChangeTypes.js";
import { numberSchema } from "../../simple-tree/index.js";
import { brand } from "../../util/index.js";
// eslint-disable-next-line import-x/no-internal-modules
import { Change } from "../feature-libraries/modular-schema/modularChangesetUtil.js";
import { jsonSequenceRootSchema } from "../sequenceRootUtils.js";
import { chunkToMapTreeField } from "../utils.js";

function changeWithRelevantRoots(ranges: readonly DetachedNodeRange[]): SharedTreeChange {
	const innerChange = Change.empty();
	for (const { id, count } of ranges) {
		innerChange.crossFieldKeys.set(
			{ revision: id.major, localId: brand(id.minor), target: NodeMoveType.Attach },
			count,
			{ nodeId: undefined, field: rootFieldKey },
		);
	}
	return { changes: [{ type: "data", innerChange }] };
}

describe("SharedTreeChangeEnricher", () => {
	function setup(values: number[], gap?: { start: number; end: number }) {
		const schema = new TreeStoredSchemaRepository(jsonSequenceRootSchema);
		const forest = buildChunkedForest(
			makeTreeChunker(schema, defaultSchemaPolicy, defaultIncrementalEncodingPolicy),
		);
		const index = makeDetachedFieldIndex("");
		const root = index.createRange(
			{ minor: 10 },
			undefined,
			values.length + (gap === undefined ? 0 : gap.end - gap.start),
		);
		if (gap !== undefined) {
			index.deleteRange(root, gap);
		}
		const shape = new TreeShape(brand(numberSchema.identifier), true, []);
		const chunk = new UniformChunk(shape.withTopLevelLength(values.length), values);
		forest.roots.fields.set(index.toFieldKey(root), [chunk]);
		let refreshersAdded = 0;
		const enricher = new SharedTreeChangeEnricher(
			forest,
			index,
			schema,
			undefined,
			undefined,
			() => refreshersAdded++,
		);
		return { enricher, chunk, forest, index, refreshersAdded: () => refreshersAdded };
	}

	for (const count of [8, 65_536]) {
		it(`retrieves ${count} consecutive roots as one compact refresher`, () => {
			const { enricher, chunk, refreshersAdded } = setup(
				Array.from({ length: count }, (_, i) => i),
			);
			const updated = enricher.enrich(changeWithRelevantRoots([{ id: { minor: 10 }, count }]));
			const change = updated.changes[0];
			assert(change.type === "data");
			assert.equal(change.innerChange.refreshers?.size, 1);
			const refresher = change.innerChange.refreshers.get([undefined, brand(10)]);
			assert.equal(refresher, chunk);
			assert.equal(refreshersAdded(), 1);
			assert.equal(chunk.isShared(), true);
			refresher?.referenceRemoved();
			assert.equal(chunk.isShared(), false);
		});
	}

	it("extracts a partial range at its node index without degrading uniform chunks", () => {
		const { enricher, chunk } = setup([0, 1, 2, 3, 4, 5]);
		const updated = enricher.enrich(
			changeWithRelevantRoots([{ id: { minor: 12 }, count: 2 }]),
		);
		const change = updated.changes[0];
		assert(change.type === "data");
		const refresher = change.innerChange.refreshers?.get([undefined, brand(12)]);
		assert(refresher instanceof UniformChunk);
		assert.deepEqual(refresher.values, [2, 3]);
		assert.equal(refresher.topLevelLength, 2);
		refresher.referenceRemoved();
		assert.equal(refresher.isUnreferenced(), true);
		assert.equal(chunk.isShared(), false);
		assert.deepEqual(chunk.values, [0, 1, 2, 3, 4, 5]);
	});

	it("keeps nonconsecutive detached node IDs in one forest field separate", () => {
		const { enricher, chunk, refreshersAdded } = setup([0, 3, 4], { start: 1, end: 3 });
		const updated = enricher.enrich(
			changeWithRelevantRoots([
				{ id: { minor: 10 }, count: 1 },
				{ id: { minor: 13 }, count: 2 },
			]),
		);
		const change = updated.changes[0];
		assert(change.type === "data");
		assert.deepEqual(
			change.innerChange.refreshers
				?.toArray()
				.map(([id, refresher]) => [
					id,
					chunkToMapTreeField(refresher).map((node) => node.value),
				]),
			[
				[[undefined, 10], [0]],
				[
					[undefined, 13],
					[3, 4],
				],
			],
		);
		assert.equal(refreshersAdded(), 2);
		for (const refresher of change.innerChange.refreshers?.values() ?? []) {
			refresher.referenceRemoved();
		}
		assert.equal(chunk.isShared(), false);
	});

	it("continues after a missing prefix in a later data change", () => {
		const { enricher, refreshersAdded } = setup([0, 3, 4], { start: 1, end: 3 });
		const updated = enricher.enrich({
			changes: [
				...changeWithRelevantRoots([]).changes,
				...changeWithRelevantRoots([{ id: { minor: 11 }, count: 4 }]).changes,
			],
		});
		const change = updated.changes[1];
		assert(change.type === "data");
		assert.deepEqual(
			change.innerChange.refreshers
				?.toArray()
				.map(([id, refresher]) => [
					id,
					chunkToMapTreeField(refresher).map((node) => node.value),
				]),
			[
				[
					[undefined, 13],
					[3, 4],
				],
			],
		);
		assert.equal(refreshersAdded(), 1);
		for (const refresher of change.innerChange.refreshers?.values() ?? []) {
			refresher.referenceRemoved();
		}
	});
});
