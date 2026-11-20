/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/core-utils/internal";

import { RangeMap } from "../../util/index.js";

import type { DetachedNodeId } from "./delta.js";
import { makeDetachedNodeId, offsetDetachId, subtractDetachedNodeId } from "./deltaUtil.js";
import type {
	DetachedFieldRange,
	DetachedFieldSummaryData,
	ForestRootId,
} from "./detachedFieldIndexTypes.js";

/**
 * Validates summary records and groups them in forest field order, without expanding node ranges.
 * Legacy singleton summaries retain their historical ID bounds.
 * @param validateLegacyBounds - Enforce range-format bounds even for legacy-shaped singleton records.
 */
export function getDetachedFieldSummaryRanges(
	summary: DetachedFieldSummaryData,
	validateLegacyBounds: boolean = false,
): Map<ForestRootId, DetachedFieldRange[]> {
	if (validateLegacyBounds) {
		assert(
			Number.isSafeInteger(summary.maxId) && summary.maxId >= -1,
			"Invalid detached field range bounds",
		);
	}
	const fields = new Map<ForestRootId, DetachedFieldRange[]>();
	const detachedIds = new RangeMap<DetachedNodeId, true>(
		offsetDetachId,
		subtractDetachedNodeId,
	);
	for (const [major, entries] of summary.data) {
		for (const [minor, entry] of entries) {
			const { root } = entry;
			const isLegacy = entry.index === undefined && entry.count === undefined;
			const index = isLegacy ? 0 : entry.index;
			const count = isLegacy ? 1 : entry.count;
			assert(
				index !== undefined && count !== undefined,
				"Incomplete detached field range metadata",
			);
			if (validateLegacyBounds || !isLegacy) {
				assert(
					Number.isSafeInteger(minor) &&
						Number.isSafeInteger(index) &&
						index >= 0 &&
						Number.isSafeInteger(count) &&
						count > 0 &&
						Number.isSafeInteger(minor + (count - 1)) &&
						Number.isSafeInteger(index + count) &&
						Number.isSafeInteger(root) &&
						root >= -1 &&
						Number.isSafeInteger(summary.maxId) &&
						root <= summary.maxId,
					"Invalid detached field range bounds",
				);
			}
			const id = makeDetachedNodeId(major, minor);
			const first = detachedIds.getFirst(id, count);
			assert(
				first.value === undefined && first.length === count,
				"Summary contains overlapping detached node IDs",
			);
			detachedIds.set(id, count, true);
			let records = fields.get(root);
			if (records === undefined) {
				records = [];
				fields.set(root, records);
			}
			const previous = records[0];
			assert(
				previous === undefined || previous.id.major === major,
				"Summary contains multiple major IDs in one forest field",
			);
			records.push({ id, root, index, count });
		}
	}
	for (const records of fields.values()) {
		records.sort((a, b) => a.index - b.index);
		let nextIndex = 0;
		for (const record of records) {
			assert(
				record.index === nextIndex,
				"Summary contains overlapping forest field ranges or gaps",
			);
			nextIndex += record.count;
		}
	}
	return fields;
}
