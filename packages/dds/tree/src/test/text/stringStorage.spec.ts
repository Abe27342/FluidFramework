/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";
import { asAlpha } from "../../api.js";
import { SummaryType } from "@fluidframework/driver-definitions";
import { convertSummaryTreeToITree } from "@fluidframework/runtime-utils/internal";
import {
	MockFluidDataStoreRuntime,
	MockDeltaConnection,
	MockStorage,
} from "@fluidframework/test-runtime-utils/internal";

import { EmptyKey, rootFieldKey, tryGetChunk, type TreeChunk } from "../../core/index.js";
// eslint-disable-next-line import-x/no-internal-modules
import { UniformChunk } from "../../feature-libraries/chunked-forest/uniformChunk.js";
// eslint-disable-next-line import-x/no-internal-modules
import { BasicChunk } from "../../feature-libraries/chunked-forest/basicChunk.js";
// eslint-disable-next-line import-x/no-internal-modules
import { ChunkedForest } from "../../feature-libraries/chunked-forest/chunkedForest.js";
// eslint-disable-next-line import-x/no-internal-modules
import { StringChunk } from "../../feature-libraries/chunked-forest/stringChunk.js";
// eslint-disable-next-line import-x/no-internal-modules
import { ForestTypeStringPrototype } from "../../shared-tree/forestTypeStringPrototype.js";
// eslint-disable-next-line import-x/no-internal-modules
import { forestSummaryKey } from "../../feature-libraries/forest-summary/summaryFormatCommon.js";
// eslint-disable-next-line import-x/no-internal-modules
import { summaryContentBlobKey } from "../../feature-libraries/forest-summary/summaryFormatV3.js";
// eslint-disable-next-line import-x/no-internal-modules
import { summarizablesTreeKey } from "../../shared-tree-core/summaryTypes.js";
import {
	createIndependentTreeAlpha,
	ForestTypeReference,
	ForestTypeOptimized,
	TreeAlpha,
} from "../../shared-tree/index.js";
import {
	getInnerNode,
	TreeViewConfiguration,
	SchemaFactory,
} from "../../simple-tree/index.js";
// eslint-disable-next-line import-x/no-internal-modules
import { UnhydratedFlexTreeNode } from "../../simple-tree/core/unhydratedFlexTree.js";
// eslint-disable-next-line import-x/no-internal-modules
import { plainTextFromString } from "../../text/textDomain.js";
import { PlainText } from "../../text/index.js";
import { FluidClientVersion, type CodecWriteOptions } from "../../codec/index.js";
import {
	FieldBatchFormatVersion,
	fieldBatchCodecBuilder,
	defaultSchemaPolicy,
	TreeCompressionStrategy,
} from "../../feature-libraries/index.js";
import { FormatValidatorBasic } from "../../external-utilities/index.js";
import { ajvValidator } from "../codec/index.js";
import {
	createTestUndoRedoStacks,
	TestTreeProviderLite,
	makeTestFieldBatchContexts,
} from "../utils.js";
import { configuredSharedTree } from "../../treeFactory.js";
import type { JsonCompatible } from "../../util/index.js";

function createView(forest = ForestTypeStringPrototype) {
	const view = createIndependentTreeAlpha({ forest }).viewWith(
		new TreeViewConfiguration({ schema: PlainText.Tree }),
	);
	view.initialize(PlainText.Tree.fromString(""));
	return asAlpha(view);
}

function pieces(root: PlainText.Tree): StringChunk[] {
	const inner = getInnerNode(root);
	assert(inner.isHydrated());
	const forest = inner.context.checkout.forest;
	assert(forest instanceof ChunkedForest);
	const result: StringChunk[] = [];
	function visit(chunk: TreeChunk): void {
		if (chunk instanceof StringChunk) {
			result.push(chunk);
		} else {
			assert(chunk instanceof BasicChunk, "Unexpected unpacked chunk");
			for (const field of chunk.fields.values()) {
				for (const child of field) {
					visit(child);
				}
			}
		}
	}
	for (const chunk of forest.roots.fields.get(rootFieldKey) ?? []) {
		visit(chunk);
	}
	return result;
}

describe("PlainText string storage prototype", () => {
	describe("experimental string-run messages and summaries", () => {
		const codecOptions: CodecWriteOptions = {
			jsonValidator: FormatValidatorBasic,
			minVersionForCollab: FluidClientVersion.v2_74,
			writeVersionOverrides: new Map([
				[fieldBatchCodecBuilder.name, FieldBatchFormatVersion.vTextExperimental],
			]),
			allowPossiblyIncompatibleWriteVersionOverrides: true,
		};
		for (const [name, forest] of [
			["packed", ForestTypeStringPrototype],
			["optimized", ForestTypeOptimized],
			["reference", ForestTypeReference],
		] as const) {
			it(`round trips a 4000-character insertion through ${name} messages and a summary`, async () => {
				const factory = configuredSharedTree({ forest, ...codecOptions }).getFactory();
				const provider = new TestTreeProviderLite(2, factory);
				const [source, remote] = provider.trees;
				assert(source !== undefined && remote !== undefined);
				const config = new TreeViewConfiguration({ schema: PlainText.Tree });
				const localView = source.viewWith(config);
				localView.initialize(PlainText.Tree.fromString(""));
				provider.synchronizeMessages();
				const remoteView = remote.viewWith(config);
				const history = createTestUndoRedoStacks(asAlpha(localView).events);
				const text = "ab\u{1F600}c".repeat(1000);
				localView.root.insertAt(0, text);
				let message = provider.peekNextMessage();
				while (
					message?.type === "op" &&
					(message.contents as { type?: string }).type === "idAllocation"
				) {
					provider.synchronizeMessages({ count: 1 });
					message = provider.peekNextMessage();
				}
				assert(message !== undefined);
				const encoded = JSON.stringify(message.contents);
				assert(encoded.includes(JSON.stringify(text)), "The op must contain one text string");
				assert(encoded.includes('"version":"text"'));
				provider.synchronizeMessages();
				assert.equal(remoteView.root.fullString(), text);
				assert.equal(remoteView.root.characterCount(), 4000);
				if (forest === ForestTypeStringPrototype) {
					assert(pieces(remoteView.root).length < 10, "Remote text must remain packed");
				}

				const undo = history.undoStack.pop();
				assert(undo !== undefined);
				undo.revert();
				provider.synchronizeMessages();
				assert.equal(remoteView.root.characterCount(), 0);
				const redo = history.redoStack.pop();
				assert(redo !== undefined);
				redo.revert();
				provider.synchronizeMessages();
				assert.equal(remoteView.root.fullString(), text);

				const summary = source.getAttachSummary(true).summary;
				const indexes = summary.tree[summarizablesTreeKey];
				assert(indexes?.type === SummaryType.Tree);
				const forestSummary = indexes.tree[forestSummaryKey];
				assert(forestSummary?.type === SummaryType.Tree);
				const forestBlob = forestSummary.tree[summaryContentBlobKey];
				assert(
					forestBlob?.type === SummaryType.Blob && typeof forestBlob.content === "string",
				);
				assert(
					forestBlob.content.includes(JSON.stringify(text)),
					"The forest must encode a text run",
				);
				const loaded = await factory.load(
					new MockFluidDataStoreRuntime({ idCompressor: provider.getCompressor(source) }),
					source.id,
					{
						deltaConnection: new MockDeltaConnection(
							() => 0,
							() => {},
						),
						objectStorage: new MockStorage(convertSummaryTreeToITree(summary)),
					},
					factory.attributes,
				);
				const loadedView = loaded.viewWith(config);
				assert.deepEqual(loadedView.root.charactersCopy(), localView.root.charactersCopy());
				if (forest === ForestTypeStringPrototype) {
					assert(pieces(loadedView.root).length < 10, "Loaded text must remain packed");
				}

				localView.root.insertAt(1, "L");
				remoteView.root.insertAt(1, "R");
				provider.synchronizeMessages();
				assert.deepEqual(localView.root.charactersCopy(), remoteView.root.charactersCopy());
				assert.equal(localView.root.characterCount(), 4002);
				history.unsubscribe();
				loadedView.dispose();
				remoteView.dispose();
				localView.dispose();
			});
		}

		it("encodes and imports a whole PlainText subtree without expanding its character field", () => {
			const view = createView();
			const text = "\u{1F600}".repeat(4000);
			view.root.insertAt(0, text);
			const inner = getInnerNode(view.root);
			const cursor = inner.borrowCursor();
			cursor.exitNode();
			const { encode } = makeTestFieldBatchContexts({
				encodeType: TreeCompressionStrategy.Compressed,
				isSummary: true,
				schema: { schema: inner.context.schema, policy: defaultSchemaPolicy },
			});
			const encoded = fieldBatchCodecBuilder.build(codecOptions).encode([cursor], encode);
			cursor.enterNode(0);
			assert(JSON.stringify(encoded).includes(JSON.stringify(text)));
			const decoded = TreeAlpha.importCompressed(
				PlainText.Tree,
				JSON.parse(JSON.stringify(encoded)) as JsonCompatible,
				{ jsonValidator: ajvValidator },
			);
			assert.equal(decoded.fullString(), text);
			assert.equal(decoded.characterCount(), 4000);
			view.dispose();
		});
	});

	it("keeps fromString packed through unhydrated reads, edits, and hydration", () => {
		const text = PlainText.Tree.fromString("ab\u{1F600}".repeat(4000));
		const reference = plainTextFromString("ab\u{1F600}".repeat(4000), false);
		const inner = getInnerNode(text);
		assert(inner instanceof UnhydratedFlexTreeNode);
		const array = inner.getBoxed(EmptyKey).boxedAt(0);
		assert(array instanceof UnhydratedFlexTreeNode);
		const field = array.getBoxed(EmptyKey);
		const arrayObject = array.treeNode;
		assert(field.stringChunks !== undefined);
		assert(field.stringChunks.length < 10);
		const anchor = text.createInsertionAnchor(7);
		const events: unknown[] = [];
		text.onCharactersChanged((ops) => events.push(ops));
		for (const node of [text, reference]) {
			// Read first, to populate caches that the subsequent edits must invalidate.
			assert.equal([...node.characters()].join(""), node.fullString());
			assert.equal(node.charactersCopy().length, 12000);
			node.insertAt(2, "\uD800");
			node.insertAt(3, "\uDC00");
			node.moveRangeToIndex(200, 40, 60);
			node.removeRange(100, 150);
		}
		assert.deepEqual(text.charactersCopy(), reference.charactersCopy());
		assert(field.stringChunks !== undefined, "Unhydrated operations expanded character nodes");
		assert.equal(anchor.index, 9);
		assert.equal(events.length, 4);
		const view = createIndependentTreeAlpha({ forest: ForestTypeStringPrototype }).viewWith(
			new TreeViewConfiguration({ schema: PlainText.Tree }),
		);
		view.initialize(text);
		assert.equal(view.root, text);
		assert(arrayObject !== undefined);
		assert.equal(getInnerNode(arrayObject).isHydrated(), true);
		assert(field.stringChunks !== undefined, "Hydration expanded character nodes");
		assert.equal(
			pieces(view.root).reduce((n, chunk) => n + chunk.topLevelLength, 0),
			text.characterCount(),
		);
		view.root.insertAt(0, "x");
		assert.equal(anchor.index, 10);
		assert.equal(events.length, 5);
		anchor.dispose();
		view.dispose();
	});

	it("preserves packed text nested inside an ordinary unhydrated object", () => {
		const sf = new SchemaFactory("string-storage-nested");
		class Holder extends sf.object("Holder", {
			text: PlainText.Tree,
			label: sf.string,
			values: sf.array("Numbers", sf.number),
		}) {}
		const text = PlainText.Tree.fromString("hello");
		const root = new Holder({
			text,
			label: "test",
			values: Array.from({ length: 1000 }, (_, i) => i),
		});
		const view = createIndependentTreeAlpha({ forest: ForestTypeStringPrototype }).viewWith(
			new TreeViewConfiguration({ schema: Holder }),
		);
		// Snapshot caching must not make later edits disappear.
		getInnerNode(root).borrowCursor();
		text.insertAt(5, " world");
		view.initialize(root);
		assert.equal(view.root, root);
		assert.equal(view.root.text, text);
		assert.equal(text.fullString(), "hello world");
		const textCursor = getInnerNode(text).borrowCursor();
		textCursor.enterField(EmptyKey);
		textCursor.enterNode(0);
		textCursor.enterField(EmptyKey);
		assert.equal(textCursor.getFieldLength(), 11);
		assert(textCursor.firstNode());
		assert(tryGetChunk(textCursor) instanceof StringChunk);
		textCursor.exitNode();
		textCursor.exitField();
		textCursor.exitNode();
		textCursor.exitField();
		const valuesCursor = getInnerNode(root.values).borrowCursor();
		valuesCursor.enterField(EmptyKey);
		assert(valuesCursor.firstNode());
		assert(
			tryGetChunk(valuesCursor) instanceof UniformChunk,
			"Unrelated siblings must retain normal chunking",
		);
		valuesCursor.exitNode();
		valuesCursor.exitField();
		view.dispose();
	});

	it("keeps packed fromString correct when inserted into the reference forest", () => {
		const text = PlainText.Tree.fromString("a\u{1F600}b".repeat(100));
		const view = createIndependentTreeAlpha({ forest: ForestTypeReference }).viewWith(
			new TreeViewConfiguration({ schema: PlainText.Tree }),
		);
		view.initialize(text);
		assert.equal(view.root, text);
		assert.equal(text.fullString(), "a\u{1F600}b".repeat(100));
		text.insertAt(1, "x");
		assert.equal(text.characterCount(), 301);
		view.dispose();
	});

	it("loads an ordinary optimized-forest summary into packed storage", async () => {
		const provider = new TestTreeProviderLite(1);
		const source = provider.trees[0];
		assert(source !== undefined);
		const config = new TreeViewConfiguration({ schema: PlainText.Tree });
		const view = source.viewWith(config);
		view.initialize(PlainText.Tree.fromString("ab\u{1F600}".repeat(200)));
		provider.synchronizeMessages();
		const summary = convertSummaryTreeToITree(source.getAttachSummary(true).summary);
		const factory = configuredSharedTree({ forest: ForestTypeStringPrototype }).getFactory();
		const loaded = await factory.load(
			new MockFluidDataStoreRuntime({ idCompressor: provider.getCompressor(source) }),
			"loaded",
			{
				deltaConnection: new MockDeltaConnection(
					() => 0,
					() => {},
				),
				objectStorage: new MockStorage(summary),
			},
			factory.attributes,
		);
		const loadedView = loaded.viewWith(config);
		assert.deepEqual(loadedView.root.charactersCopy(), view.root.charactersCopy());
		assert.equal(
			pieces(loadedView.root).reduce((n, chunk) => n + chunk.topLevelLength, 0),
			600,
		);
		loadedView.root.insertAt(123, "edit");
		assert.equal(loadedView.root.characterCount(), 604);
		loadedView.dispose();
		view.dispose();
	});

	it("preserves copy-on-write isolation, merging, undo, and redo", () => {
		const view = createView();
		view.root.insertAt(0, "abcdef");
		const fork = view.fork();
		assert(fork.hasRootSchema(PlainText.Tree));
		const { undoStack, redoStack, unsubscribe } = createTestUndoRedoStacks(view.events);
		view.root.insertAt(2, "XY");
		assert.equal(fork.root.fullString(), "abcdef");
		assert.equal(view.root.fullString(), "abXYcdef");
		const undo = undoStack.pop();
		assert(undo !== undefined);
		undo.revert();
		assert.equal(view.root.fullString(), "abcdef");
		const redo = redoStack.pop();
		assert(redo !== undefined);
		redo.revert();
		assert.equal(view.root.fullString(), "abXYcdef");
		fork.root.insertAt(5, "Z");
		view.merge(fork);
		assert.equal(view.root.fullString(), "abXYcdeZf");
		assert.equal(
			pieces(view.root).reduce((n, chunk) => n + chunk.topLevelLength, 0),
			9,
		);
		unsubscribe();
		view.dispose();
	});

	it("packs remote inserts and converges after concurrent edits", () => {
		const provider = new TestTreeProviderLite(
			2,
			configuredSharedTree({
				forest: ForestTypeStringPrototype,
			}).getFactory(),
		);
		const config = new TreeViewConfiguration({ schema: PlainText.Tree });
		const first = provider.trees[0]?.viewWith(config);
		const second = provider.trees[1]?.viewWith(config);
		assert(first !== undefined && second !== undefined);
		first.initialize(PlainText.Tree.fromString(""));
		provider.synchronizeMessages();
		first.root.insertAt(0, "ab\u{1F600}".repeat(100));
		provider.synchronizeMessages();
		assert.deepEqual(first.root.charactersCopy(), second.root.charactersCopy());
		assert.equal(
			pieces(second.root).reduce((n, chunk) => n + chunk.topLevelLength, 0),
			300,
		);
		first.root.insertAt(2, "left");
		second.root.insertAt(2, "right");
		first.root.removeRange(20, 30);
		second.root.moveRangeToIndex(80, 40, 50);
		provider.synchronizeMessages();
		assert.deepEqual(first.root.charactersCopy(), second.root.charactersCopy());
		assert(pieces(second.root).length < 30);
		first.dispose();
		second.dispose();
	});

	it("tracks insertion anchors without unpacking pieces", () => {
		const view = createView();
		view.root.insertAt(0, "abc");
		const anchor = view.root.createInsertionAnchor(1);
		view.root.insertAt(0, "\u{1F600}");
		assert.equal(anchor.index, 2);
		view.root.removeRange(0, 1);
		assert.equal(anchor.index, 1);
		assert.equal(pieces(view.root).length, 1);
		anchor.dispose();
		view.dispose();
	});

	it("round trips through the unchanged wire codec", () => {
		const view = createView();
		view.root.insertAt(0, "ab\u{1F600}".repeat(100));
		view.root.insertAt(5, "\uD800");
		view.root.insertAt(6, "\uDC00");
		const encoded = TreeAlpha.exportCompressed(view.root, {
			minVersionForCollab: FluidClientVersion.v2_0,
		});
		const decoded = TreeAlpha.importCompressed(PlainText.Tree, encoded, {
			jsonValidator: ajvValidator,
		});
		assert.deepEqual(decoded.charactersCopy(), view.root.charactersCopy());
		const reloaded = createIndependentTreeAlpha({
			forest: ForestTypeStringPrototype,
		}).viewWith(new TreeViewConfiguration({ schema: PlainText.Tree }));
		reloaded.initialize(decoded);
		assert.deepEqual(reloaded.root.charactersCopy(), view.root.charactersCopy());
		assert.equal(
			pieces(reloaded.root).reduce((n, chunk) => n + chunk.topLevelLength, 0),
			view.root.characterCount(),
		);
		reloaded.dispose();
		view.dispose();
	});

	it("keeps a large paste packed through reads, splits, moves, and deletes", () => {
		const view = createView();
		const reference = createView(ForestTypeReference);
		const text = "abc\u{1F600}".repeat(2000);
		for (const root of [view.root, reference.root]) {
			root.insertAt(0, text);
			root.insertAt(15, " inserted ");
			root.moveRangeToIndex(300, 10, 30);
			root.removeRange(100, 250);
		}
		assert.equal(view.root.fullString(), reference.root.fullString());
		assert.deepEqual(view.root.charactersCopy(), reference.root.charactersCopy());
		const stored = pieces(view.root);
		assert.equal(
			stored.reduce((n, chunk) => n + chunk.topLevelLength, 0),
			view.root.characterCount(),
		);
		assert(stored.length < 100, `Unexpected fragmentation: ${stored.length}`);
		view.dispose();
		reference.dispose();
	});

	it("bounds fragmentation during middle typing", () => {
		const view = createView();
		for (let i = 0; i < 1000; i++) {
			view.root.insertAt(Math.floor(i / 2), i % 2 === 0 ? "a" : "b");
		}
		assert.equal(view.root.characterCount(), 1000);
		assert(pieces(view.root).length < 20);
		view.dispose();
	});

	it("preserves separately inserted surrogate halves and event coordinates", () => {
		const view = createView();
		const events: (readonly PlainText.TextOp[] | undefined)[] = [];
		view.root.onCharactersChanged((ops) => events.push(ops));
		view.root.insertAt(0, "\uD800");
		view.root.insertAt(1, "\uDC00");
		assert.deepEqual(view.root.charactersCopy(), ["\uD800", "\uDC00"]);
		assert.equal(view.root.characterCount(), 2);
		assert.deepEqual(events[1], [
			{ type: "retain", count: 1 },
			{ type: "insert", text: "\uDC00" },
		]);
		view.root.insertAt(1, "");
		assert.equal(events.length, 2);
		assert.throws(() => view.root.insertAt(4, "x"));
		assert.throws(() => view.root.insertAt(-1, "x"));
		view.dispose();
	});

	it("matches the reference forest across deterministic mixed edits", () => {
		const view = createView();
		const reference = createView(ForestTypeReference);
		let state = 42;
		const random = (max: number): number => {
			state = (state * 1664525 + 1013904223) % 0x1_00_00_00_00;
			return state % max;
		};
		for (let i = 0; i < 300; i++) {
			const length = view.root.characterCount();
			const start = random(length + 1);
			const end = start + random(length - start + 1);
			const destination = random(length + 1);
			const operation = random(3);
			const text = ["a", "\u{1F600}", "\uD800", "\uDC00", "xyz"][random(5)] ?? "";
			for (const root of [view.root, reference.root]) {
				if (operation === 0) {
					root.insertAt(start, text);
				} else if (operation === 1) {
					root.removeRange(start, end);
				} else {
					root.moveRangeToIndex(destination, start, end);
				}
			}
			assert.deepEqual(view.root.charactersCopy(), reference.root.charactersCopy());
			assert.equal(view.root.fullString(), reference.root.fullString());
		}
		view.dispose();
		reference.dispose();
	});
});
