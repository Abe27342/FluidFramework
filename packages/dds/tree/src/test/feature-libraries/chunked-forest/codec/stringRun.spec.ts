/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import {
	FluidClientVersion,
	VersionDispatchingCodecBuilder,
	type CodecWriteOptions,
} from "../../../../codec/index.js";
import {
	LeafNodeStoredSchema,
	ValueSchema,
	tryGetChunk,
	type ITreeCursorSynchronous,
	type TreeNodeSchemaIdentifier,
} from "../../../../core/index.js";
import {
	fieldBatchCodecBuilder,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../../feature-libraries/chunked-forest/codec/codecs.js";
import {
	FieldBatchFormatVersion,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../../feature-libraries/chunked-forest/codec/format/index.js";
import {
	chunkFieldSingle,
	combineChunks,
	defaultChunkPolicy,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../../feature-libraries/chunked-forest/chunkTree.js";
import {
	StringChunk,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../../feature-libraries/chunked-forest/stringChunk.js";
import {
	TreeCompressionStrategy,
	cursorForJsonableTreeField,
	defaultSchemaPolicy,
	jsonableTreeFromFieldCursor,
} from "../../../../feature-libraries/index.js";
import { SchemaFactory } from "../../../../simple-tree/index.js";
import {
	toInitialSchema,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../../simple-tree/toStoredSchema.js";
import { brand } from "../../../../util/index.js";
import { ajvValidator } from "../../../codec/index.js";
import { makeTestFieldBatchContexts, testIdCompressor } from "../../../utils.js";

const type = brand<TreeNodeSchemaIdentifier>(SchemaFactory.string.identifier);
const otherType = brand<TreeNodeSchemaIdentifier>("other-string");
const storedSchema = toInitialSchema([SchemaFactory.string, SchemaFactory.number]);
const schema = {
	schema: {
		...storedSchema,
		nodeSchema: new Map([
			...storedSchema.nodeSchema,
			[otherType, new LeafNodeStoredSchema(ValueSchema.String)],
		]),
	},
	policy: defaultSchemaPolicy,
};
const options: CodecWriteOptions = {
	jsonValidator: ajvValidator,
	minVersionForCollab: FluidClientVersion.v2_74,
	writeVersionOverrides: new Map([
		[fieldBatchCodecBuilder.name, FieldBatchFormatVersion.vTextExperimental],
	]),
	allowPossiblyIncompatibleWriteVersionOverrides: true,
};

describe("string-run codec", () => {
	const codec = fieldBatchCodecBuilder.build(options);
	const contexts = makeTestFieldBatchContexts({
		encodeType: TreeCompressionStrategy.Compressed,
		schema,
	});

	function checkRun(cursor: ITreeCursorSynchronous, text: string): void {
		const encoded = codec.encode([cursor], contexts.encode);
		assert.deepEqual(encoded, {
			version: FieldBatchFormatVersion.vTextExperimental,
			identifiers: [],
			shapes: [{ g: { type } }],
			data: [[0, text]],
		});
		const decoded = codec.decode(encoded, contexts.decode);
		assert.equal(decoded.length, 1);
		const field = decoded[0];
		assert(field !== undefined);
		const chunk = chunkFieldSingle(field, {
			policy: defaultChunkPolicy,
			idCompressor: testIdCompressor,
		});
		const packed = chunk.cursor();
		let length = 0;
		let hasNode = packed.firstNode();
		while (hasNode) {
			const piece = tryGetChunk(packed);
			assert(piece instanceof StringChunk, "Decoded characters must stay packed");
			length += piece.topLevelLength;
			hasNode = packed.seekNodes(piece.topLevelLength);
		}
		assert.equal(length, [...text].length);
		assert.deepEqual(
			jsonableTreeFromFieldCursor(field),
			[...text].map((value) => ({ type, value })),
		);
		chunk.referenceRemoved();
	}

	for (const text of ["abcd".repeat(1000), "\u{1F600}".repeat(4000)]) {
		it(`encodes 4000 code points in one string (${text.length} UTF-16 units)`, () => {
			const chunk = combineChunks(StringChunk.fromString(type, text));
			try {
				checkRun(chunk.cursor(), text);
			} finally {
				chunk.referenceRemoved();
			}
		});
	}

	it("packs ordinary cursors without requiring the string-storage forest", () => {
		const text = "abcd".repeat(1000);
		checkRun(cursorForJsonableTreeField([...text].map((value) => ({ type, value }))), text);
	});

	it("encodes packed spans without reading individual character values", () => {
		const chunk = combineChunks(StringChunk.fromString(type, "\u{1F600}".repeat(4000)));
		const original = StringChunk.prototype.characterAtOffset;
		StringChunk.prototype.characterAtOffset = () => assert.fail("Read a character value");
		try {
			assert.deepEqual(codec.encode([chunk.cursor()], contexts.encode), {
				version: FieldBatchFormatVersion.vTextExperimental,
				identifiers: [],
				shapes: [{ g: { type } }],
				data: [[0, "\u{1F600}".repeat(4000)]],
			});
		} finally {
			StringChunk.prototype.characterAtOffset = original;
			chunk.referenceRemoved();
		}
	});

	it("encodes slices and adjacent pieces without their excluded content", () => {
		const [source] = StringChunk.fromString(type, "prefix-middle-suffix");
		assert(source !== undefined);
		const chunk = combineChunks([source.slice(7, 10), source.slice(10, 13)]);
		try {
			checkRun(chunk.cursor(), "middle");
		} finally {
			chunk.referenceRemoved();
			source.referenceRemoved();
		}
	});

	it("preserves exceptional atoms and type boundaries", () => {
		const nodes = [
			...["a", "b", "", "cd", "\u{1F600}", "\uD83D", "\uDE00", "e"].map((value) => ({
				type,
				value,
			})),
			{ type: otherType, value: "f" },
			{ type: otherType, value: "g" },
			{ type: brand<TreeNodeSchemaIdentifier>(SchemaFactory.number.identifier), value: 42 },
		];
		const encoded = codec.encode([cursorForJsonableTreeField(nodes)], contexts.encode);
		assert.deepEqual(codec.decode(encoded, contexts.decode).map(jsonableTreeFromFieldCursor), [
			nodes,
		]);
	});

	it("packs runs within a polymorphic sequence field", () => {
		const sf = new SchemaFactory("string-run-codec");
		class Mixed extends sf.array("Mixed", [sf.string, sf.number]) {}
		const nodes = [
			{ type, value: "a" },
			{ type, value: "b" },
			{ type: brand<TreeNodeSchemaIdentifier>(sf.number.identifier), value: 42 },
			{ type, value: "c" },
			{ type, value: "d" },
		];
		const root = {
			type: brand<TreeNodeSchemaIdentifier>(Mixed.identifier),
			fields: { "": nodes },
		};
		const encoded = codec.encode([cursorForJsonableTreeField([root])], {
			...contexts.encode,
			schema: { schema: toInitialSchema(Mixed), policy: defaultSchemaPolicy },
		});
		assert(JSON.stringify(encoded).includes('"ab"'));
		assert(JSON.stringify(encoded).includes('"cd"'));
		assert.deepEqual(codec.decode(encoded, contexts.decode).map(jsonableTreeFromFieldCursor), [
			[root],
		]);
	});

	it("does not coalesce separately packed surrogate halves", () => {
		const chunk = combineChunks([
			...StringChunk.fromString(type, "ab\uD83D"),
			...StringChunk.fromString(type, "\uDE00cd"),
		]);
		try {
			const encoded = codec.encode([chunk.cursor()], contexts.encode);
			assert.deepEqual(
				codec.decode(encoded, contexts.decode).map(jsonableTreeFromFieldCursor),
				[["a", "b", "\uD83D", "\uDE00", "c", "d"].map((value) => ({ type, value }))],
			);
		} finally {
			chunk.referenceRemoved();
		}
	});

	for (const payload of ["", 42, null, ["abc"]]) {
		it(`rejects invalid string-run payload ${JSON.stringify(payload)}`, () => {
			assert.throws(() =>
				codec.decode(
					{
						version: "text",
						identifiers: [],
						shapes: [{ g: { type } }],
						data: [[0, payload]],
					},
					contexts.decode,
				),
			);
		});
	}

	it("keeps stable writers unchanged and lets new readers read both stable formats", () => {
		const text = "abcd".repeat(1000);
		const chunk = combineChunks(StringChunk.fromString(type, text));
		try {
			for (const minVersionForCollab of [FluidClientVersion.v2_0, FluidClientVersion.v2_74]) {
				const stable = fieldBatchCodecBuilder.build({
					jsonValidator: ajvValidator,
					minVersionForCollab,
				});
				const encoded = stable.encode([chunk.cursor()], contexts.encode);
				assert(!JSON.stringify(encoded).includes(JSON.stringify(text)));
				assert.deepEqual(
					codec.decode(encoded, contexts.decode).map(jsonableTreeFromFieldCursor),
					[[...text].map((value) => ({ type, value }))],
				);
			}
		} finally {
			chunk.referenceRemoved();
		}
	});

	it("requires an explicit incompatible-format override", () => {
		assert.throws(() =>
			fieldBatchCodecBuilder.build({
				...options,
				allowPossiblyIncompatibleWriteVersionOverrides: false,
			}),
		);
	});

	it("does not accept the new shape labeled as a stable format", () => {
		for (const version of [FieldBatchFormatVersion.v1, FieldBatchFormatVersion.v2]) {
			assert.throws(() =>
				codec.decode(
					{ version, identifiers: [], shapes: [{ g: { type } }], data: [[0, "abc"]] },
					contexts.decode,
				),
			);
		}
	});

	it("is rejected by a reader that only supports the stable formats", () => {
		const legacyReader = VersionDispatchingCodecBuilder.build(
			"LegacyFieldBatch",
			fieldBatchCodecBuilder.registry.filter(
				(entry) => typeof entry.formatVersion === "number",
			),
		).build({
			jsonValidator: ajvValidator,
			minVersionForCollab: FluidClientVersion.v2_74,
		});
		assert.throws(
			() =>
				legacyReader.decode(
					{ version: "text", identifiers: [], shapes: [{ g: { type } }], data: [[0, "abc"]] },
					contexts.decode,
				),
			/Unsupported version/,
		);
	});

	it("preserves the existing encoding of non-string sequences", () => {
		const nodes = [1, 2, 3].map((value) => ({
			type: brand<TreeNodeSchemaIdentifier>(SchemaFactory.number.identifier),
			value,
		}));
		const stable = fieldBatchCodecBuilder.build({
			jsonValidator: ajvValidator,
			minVersionForCollab: FluidClientVersion.v2_74,
		});
		const previous = stable.encode([cursorForJsonableTreeField(nodes)], contexts.encode);
		assert(previous !== null && typeof previous === "object" && !Array.isArray(previous));
		assert.deepEqual(codec.encode([cursorForJsonableTreeField(nodes)], contexts.encode), {
			...previous,
			version: FieldBatchFormatVersion.vTextExperimental,
		});
	});

	it("does not pack the explicit uncompressed strategy", () => {
		const text = "abcd";
		const encoded = codec.encode(
			[cursorForJsonableTreeField([...text].map((value) => ({ type, value })))],
			{ ...contexts.encode, encodeType: TreeCompressionStrategy.Uncompressed },
		);
		assert(!JSON.stringify(encoded).includes(JSON.stringify(text)));
		assert.deepEqual(codec.decode(encoded, contexts.decode).map(jsonableTreeFromFieldCursor), [
			[...text].map((value) => ({ type, value })),
		]);
	});
});
