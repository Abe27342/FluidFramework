/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import {
	SummaryType,
	type ISummaryBlob,
	type ISummaryTree,
	type SummaryObject,
} from "@fluidframework/driver-definitions/internal";
import type { OldestSupportedClientVersion } from "@fluidframework/runtime-definitions/internal";
import { MockStorage, validateUsageError } from "@fluidframework/test-runtime-utils/internal";

import { FluidClientVersion, FormatValidatorNoOp } from "../../codec/index.js";
import {
	DetachedFieldIndex,
	DetachedFieldIndexFormatVersion,
	detachedFieldIndexCodecBuilder,
	makeDetachedFieldIndex,
	makeDetachedNodeId,
} from "../../core/index.js";
// eslint-disable-next-line import-x/no-internal-modules
import type { FormatV1 } from "../../core/tree/detachedFieldIndexFormatV1.js";
import {
	DetachedFieldIndexSummarizer,
	DetachedFieldIndexSummaryFormatVersion,
	detachedFieldIndexBlobKey,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../feature-libraries/detachedFieldIndexSummarizer.js";
import {
	summarizablesMetadataKey,
	type SharedTreeSummarizableMetadata,
} from "../../shared-tree-core/index.js";
import { brand } from "../../util/index.js";
import { testIdCompressor, testRevisionTagCodec } from "../utils.js";

function createDetachedFieldIndexSummarizer(options?: {
	minVersionForCollab?: OldestSupportedClientVersion;
}): {
	summarizer: DetachedFieldIndexSummarizer;
	index: DetachedFieldIndex;
} {
	const index = makeDetachedFieldIndex();
	const summarizer = new DetachedFieldIndexSummarizer(
		index,
		testRevisionTagCodec,
		testIdCompressor,
		{
			jsonValidator: FormatValidatorNoOp,
			minVersionForCollab: options?.minVersionForCollab ?? FluidClientVersion.v2_74,
		},
	);
	return { summarizer, index };
}

describe("DetachedFieldIndexSummarizer", () => {
	it("loads an experimental grouped summary with a default reader but cannot downgrade it", async () => {
		const index = makeDetachedFieldIndex("Grouped");
		const root = index.createRange(makeDetachedNodeId("root", 0), undefined, 10);
		index.deleteRange(root, { start: 3, end: 7 });
		const writer = new DetachedFieldIndexSummarizer(
			index,
			testRevisionTagCodec,
			testIdCompressor,
			{
				jsonValidator: FormatValidatorNoOp,
				minVersionForCollab: FluidClientVersion.v2_0,
				writeVersionOverrides: new Map([
					[
						detachedFieldIndexCodecBuilder.name,
						DetachedFieldIndexFormatVersion.vRangeExperimental,
					],
				]),
				allowPossiblyIncompatibleWriteVersionOverrides: true,
			},
		);
		const summary = writer.summarize({ stringify: JSON.stringify });
		const { summarizer: reader, index: loaded } = createDetachedFieldIndexSummarizer();
		await reader.load(MockStorage.createFromSummary(summary.summary), JSON.parse);
		assert.deepEqual(loaded.getSummaryData(), index.getSummaryData());
		assert.deepEqual(loaded.getLocation(makeDetachedNodeId("root", 9)), { root, index: 5 });
		assert.deepEqual(loaded.getFirst(makeDetachedNodeId("root", 7), 3), {
			value: { root, index: 3 },
			length: 3,
		});
		assert.throws(
			() => reader.summarize({ stringify: JSON.stringify }),
			/Legacy detached field formats cannot encode grouped fields/,
		);
		const location = loaded.getLocation(makeDetachedNodeId("root", 7));
		loaded.deleteRange(location.root, { start: location.index, end: location.index + 2 });
		assert.deepEqual(loaded.getLocation(makeDetachedNodeId("root", 9)), { root, index: 3 });
	});

	describe("Summary metadata validation", () => {
		it("writes metadata blob with version 2", () => {
			const { summarizer } = createDetachedFieldIndexSummarizer();

			const summary = summarizer.summarize({
				stringify: JSON.stringify,
			});

			// Check if metadata blob exists
			const metadataBlob: SummaryObject | undefined =
				summary.summary.tree[summarizablesMetadataKey];
			assert(metadataBlob !== undefined, "Metadata blob should exist");
			assert.equal(metadataBlob.type, SummaryType.Blob, "Metadata should be a blob");
			const metadataContent = JSON.parse(
				metadataBlob.content as string,
			) as SharedTreeSummarizableMetadata;
			assert.equal(
				metadataContent.version,
				DetachedFieldIndexSummaryFormatVersion.v2,
				"Metadata version should be 2",
			);
		});

		it("loads with metadata blob with version 2", async () => {
			const { summarizer } = createDetachedFieldIndexSummarizer();

			const summary = summarizer.summarize({
				stringify: JSON.stringify,
			});

			// Verify metadata exists and has version = 2
			const metadataBlob: SummaryObject | undefined =
				summary.summary.tree[summarizablesMetadataKey];
			assert(metadataBlob !== undefined, "Metadata blob should exist");
			assert.equal(metadataBlob.type, SummaryType.Blob, "Metadata should be a blob");
			const metadataContent = JSON.parse(
				metadataBlob.content as string,
			) as SharedTreeSummarizableMetadata;
			assert.equal(
				metadataContent.version,
				DetachedFieldIndexSummaryFormatVersion.v2,
				"Metadata version should be 2",
			);

			// Create a new DetachedFieldIndexSummarizer and load with the above summary
			const mockStorage = MockStorage.createFromSummary(summary.summary);
			const { summarizer: summarizer2 } = createDetachedFieldIndexSummarizer();

			// Should load successfully with version 2
			await assert.doesNotReject(async () => summarizer2.load(mockStorage, JSON.parse));
		});

		it("loads pre-versioning format with no metadata blob", async () => {
			// Create data in v1 summary format.
			const mintedTag = testIdCompressor.generateCompressedId();
			const finalizedTag = testIdCompressor.normalizeToOpSpace(mintedTag);
			const detachedFieldDataV1: FormatV1 = {
				version: brand(DetachedFieldIndexFormatVersion.v1),
				data: [[brand(finalizedTag), 0, brand(1)]],
				maxId: brand(-1),
			};
			const summaryBlob: ISummaryBlob = {
				type: SummaryType.Blob,
				content: JSON.stringify(detachedFieldDataV1),
			};
			const summaryTree: ISummaryTree = {
				type: SummaryType.Tree,
				tree: {
					[detachedFieldIndexBlobKey]: summaryBlob,
				},
			};

			// Should load successfully
			const mockStorage = MockStorage.createFromSummary(summaryTree);
			const { summarizer: summarizer2 } = createDetachedFieldIndexSummarizer();

			await assert.doesNotReject(async () => summarizer2.load(mockStorage, JSON.parse));
		});

		it("fail to load with metadata blob with version > latest", async () => {
			const { summarizer } = createDetachedFieldIndexSummarizer();

			const summary = summarizer.summarize({
				stringify: JSON.stringify,
			});

			// Modify metadata to have version > latest
			const metadataBlob: SummaryObject | undefined =
				summary.summary.tree[summarizablesMetadataKey];
			assert(metadataBlob !== undefined, "Metadata blob should exist");
			assert.equal(metadataBlob.type, SummaryType.Blob, "Metadata should be a blob");
			const modifiedMetadata: SharedTreeSummarizableMetadata = {
				version: DetachedFieldIndexSummaryFormatVersion.vLatest + 1,
			};
			metadataBlob.content = JSON.stringify(modifiedMetadata);

			// Create a new DetachedFieldIndexSummarizer and load with the above summary
			const mockStorage = MockStorage.createFromSummary(summary.summary);
			const { summarizer: summarizer2 } = createDetachedFieldIndexSummarizer();

			// Should fail to load with version > latest
			await assert.rejects(
				async () => summarizer2.load(mockStorage, JSON.parse),
				validateUsageError(/Cannot read version/),
			);
		});
	});
});
