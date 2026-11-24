/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/core-utils/internal";
import type { IIdCompressor } from "@fluidframework/id-compressor";

import type { CodecAndSchema } from "../../codec/index.js";
import type { NestedMap } from "../../util/index.js";
import type { RevisionTagCodec } from "../rebase/index.js";

import { MajorCodec } from "./detachedFieldIndexCodecV2.js";
import { DetachedFieldIndexFormatVersion } from "./detachedFieldIndexFormatCommon.js";
import { FormatRange } from "./detachedFieldIndexFormatRange.js";
import type {
	DetachedFieldSummaryData,
	DetachedFieldSummaryEntry,
	Major,
	Minor,
} from "./detachedFieldIndexTypes.js";
import { getDetachedFieldSummaryRanges } from "./detachedFieldIndexValidation.js";

export function makeDetachedNodeToFieldCodecRange(
	revisionTagCodec: RevisionTagCodec,
	idCompressor: IIdCompressor,
): CodecAndSchema<DetachedFieldSummaryData> {
	const majorCodec = new MajorCodec(revisionTagCodec, idCompressor);
	return {
		schema: FormatRange,
		encode: (summary: DetachedFieldSummaryData): FormatRange => {
			getDetachedFieldSummaryRanges(summary, true);
			const data: FormatRange["data"] = [];
			for (const [major, entries] of summary.data) {
				data.push([
					majorCodec.encode(major),
					Array.from(entries, ([minor, entry]) => [
						minor,
						entry.root,
						entry.index ?? 0,
						entry.count ?? 1,
					]),
				]);
			}
			return {
				version: DetachedFieldIndexFormatVersion.vRangeExperimental,
				data,
				maxId: summary.maxId,
			};
		},
		decode: (encoded: FormatRange): DetachedFieldSummaryData => {
			const data: NestedMap<Major, Minor, DetachedFieldSummaryEntry> = new Map();
			for (const [revision, entries] of encoded.data) {
				const major = majorCodec.decode(revision);
				assert(!data.has(major), "Summary contains a duplicate major ID");
				const inner = new Map<Minor, DetachedFieldSummaryEntry>();
				for (const [minor, root, index, count] of entries) {
					assert(!inner.has(minor), "Summary contains a duplicate detached node ID");
					inner.set(minor, { root, index, count });
				}
				data.set(major, inner);
			}
			const summary = { data, maxId: encoded.maxId };
			const fields = getDetachedFieldSummaryRanges(summary, true);
			for (const entries of data.values()) {
				for (const [minor, entry] of entries) {
					const records = fields.get(entry.root);
					if (records?.length === 1 && records[0]?.count === 1) {
						entries.set(minor, { root: entry.root });
					}
				}
			}
			return summary;
		},
	};
}
