/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { createEmitter } from "@fluid-internal/client-utils";
import type { Listenable } from "@fluidframework/core-interfaces";
import { assert, oob, fail, debugAssert } from "@fluidframework/core-utils/internal";
import type { IIdCompressor } from "@fluidframework/id-compressor";

import {
	type Anchor,
	AnchorSet,
	type AnnouncedVisitor,
	type DeltaVisitor,
	type DetachedField,
	type FieldAnchor,
	type FieldKey,
	type ForestEvents,
	type IEditableForest,
	type ITreeCursorSynchronous,
	type ITreeSubscriptionCursor,
	ITreeSubscriptionCursorState,
	type PlaceIndex,
	type Range,
	TreeNavigationResult,
	type TreeStoredSchemaSubscription,
	type UpPath,
	aboveRootPlaceholder,
	combineVisitors,
	detachedFieldAsKey,
	makeBreakingVisitor,
	mapCursorField,
	rootFieldKey,
	type ChunkedCursor,
	type TreeChunk,
	type DeltaDetachedNodeId,
} from "../../core/index.js";
import {
	assertNonNegativeSafeInteger,
	brand,
	Breakable,
	type WithBreakable,
} from "../../util/index.js";

import { BasicChunk, BasicChunkCursor, type SiblingsOrKey } from "./basicChunk.js";
import {
	type ChunkEdit,
	ChunkSequence,
	ChunkSequenceEditor,
	findChunkIndex,
	getChunkIndex,
} from "./chunkSequence.js";
import {
	type ChunkCompressor,
	type IChunker,
	basicChunkTree,
	chunkField,
	chunkTree,
	coalesceUniformChunks,
	splitFieldAtIndex,
} from "./chunkTree.js";

function makeRoot(): BasicChunk {
	return new BasicChunk(aboveRootPlaceholder, new Map());
}

/** Returns the number of top-level nodes represented by a field's chunks. */
function getFieldLength(field: readonly TreeChunk[]): number {
	return field.reduce((length, chunk) => length + chunk.topLevelLength, 0);
}

/**
 * Locates a top-level node within a field's chunk representation.
 * @param field - The chunks representing the field, or an active sequence editor.
 * @param index - The node index within the field.
 * @returns The containing chunk, its array index, and the node's offset within it.
 */
export function locateNodeInChunks(
	field: readonly TreeChunk[] | ChunkSequenceEditor,
	index: number,
): { chunk: TreeChunk; indexOfChunk: number; indexWithinChunk: number } {
	const chunks = field instanceof ChunkSequenceEditor ? field.chunks : field;
	assertNonNegativeSafeInteger(index);
	const cumulativeLengths = getChunkIndex(chunks);
	if (cumulativeLengths !== undefined) {
		const chunkIndex = findChunkIndex(cumulativeLengths, index);
		const chunk = chunks[chunkIndex] ?? fail(0xaf7 /* missing edited node */);
		return {
			chunk,
			indexOfChunk: chunkIndex,
			indexWithinChunk: index - (cumulativeLengths[chunkIndex - 1] ?? 0),
		};
	}
	// Remaining node offset while scanning chunks; afterward, the offset within the matched chunk.
	let indexWithinChunk = index;
	// Array index of the chunk currently being examined.
	let indexOfChunk = 0;
	while (true) {
		const chunk = chunks[indexOfChunk] ?? oob();
		if (indexWithinChunk < chunk.topLevelLength) {
			return { chunk, indexOfChunk, indexWithinChunk };
		}
		indexWithinChunk -= chunk.topLevelLength;
		indexOfChunk++;
		if (indexOfChunk === chunks.length) {
			fail(0xaf7 /* missing edited node */);
		}
	}
}

/**
 * Ensures the node at index `index` within the field represented by `chunks` is contained in a non-shared {@link BasicChunk}.
 *
 * @param field - The owning array or sequence editor which will be modified to ensure the node at
 * `index` is in a non-shared {@link BasicChunk}.
 * @param index - The node index within the field.
 * @returns The exclusively owned {@link BasicChunk} and its chunk index. The chunk is owned by `field`.
 * @remarks
 * This function may modify the field's chunk array to ensure the node at `index` is in a non-shared {@link BasicChunk}.
 * This can include splitting chunks, and cloning.
 */
export function ensureExclusiveBasicChunk(
	field: TreeChunk[] | ChunkSequenceEditor,
	index: number,
	compressor: ChunkCompressor,
): { chunk: BasicChunk; indexOfChunk: number } {
	const chunks = field instanceof ChunkSequenceEditor ? field.chunks : field;
	const { chunk, indexOfChunk, indexWithinChunk } = locateNodeInChunks(field, index);

	// Normalize to a BasicChunk, splitting the chunk if needed.
	let finalIndexOfChunk: number;
	let basicChunk: BasicChunk;
	if (chunk instanceof BasicChunk) {
		basicChunk = chunk;
		finalIndexOfChunk = indexOfChunk;
	} else {
		// TODO:Perf: support in place editing of other chunk formats when possible:
		// 1. Support updating values in uniform chunks.
		// 2. Support traversing sequence chunks.
		//
		// Maybe build path when visitor navigates then lazily sync to chunk tree when editing?
		const newChunks = mapCursorField(chunk.cursor(), (cursor) =>
			basicChunkTree(cursor, compressor),
		);
		// TODO: this could fail for really long chunks being split (due to argument count limits).
		// Current implementations of chunks shouldn't ever be that long, but it could be an issue if they get bigger.
		if (field instanceof ChunkSequenceEditor) {
			field.splice(indexOfChunk, 1, newChunks);
		} else {
			field.splice(indexOfChunk, 1, ...newChunks);
		}
		// We just overwrote the reference to the old chunk in the array, so drop the ref count for it.
		chunk.referenceRemoved();

		// Sanity check that the chunk indexing is as expected before updating it.
		debugAssert(
			() =>
				newChunks[indexWithinChunk] === chunks[indexOfChunk + indexWithinChunk] ||
				"bad chunk indexing",
		);
		basicChunk = newChunks[indexWithinChunk] ?? oob();
		finalIndexOfChunk = indexOfChunk + indexWithinChunk;
	}

	debugAssert(() => chunks[finalIndexOfChunk] === basicChunk || "bad child index");

	// Ensure the BasicChunk we have is exclusively owned, so we can edit it in place.
	let exclusiveChunk: BasicChunk;
	if (field instanceof ChunkSequenceEditor) {
		const editor = field.acquireChild(finalIndexOfChunk);
		assert(editor.chunk instanceof BasicChunk, "Expected a basic chunk after normalization");
		exclusiveChunk = editor.chunk;
		editor.close();
	} else if (basicChunk.isShared()) {
		exclusiveChunk = basicChunk.clone();
		field[finalIndexOfChunk] = exclusiveChunk;
		basicChunk.referenceRemoved();
	} else {
		exclusiveChunk = basicChunk;
	}
	return { chunk: exclusiveChunk, indexOfChunk: finalIndexOfChunk };
}

/**
 * Layer in the visitor's path through the tree.
 */
interface StackNode {
	/**
	 * Parent node whose field is being traversed.
	 */
	mutableChunk: BasicChunk;
	nodeEditor: ChunkEdit;
	fieldEditor: ChunkSequenceEditor;
	/**
	 * Key of the parent's field.
	 */
	key: FieldKey;
}

/**
 * Implementation of IEditableForest based on copy on write chunks.
 *
 * This implementation focuses on performance.
 */
export class ChunkedForest implements IEditableForest, WithBreakable {
	private activeVisitor?: DeltaVisitor;
	private readonly rootSequence: ChunkSequence;

	public get roots(): BasicChunk {
		const root = this.rootSequence.chunks[0] ?? oob();
		assert(root instanceof BasicChunk, "Forest root must be a basic chunk");
		return root;
	}

	private readonly deltaVisitors: Set<() => AnnouncedVisitor> = new Set();
	readonly #events = createEmitter<ForestEvents>();
	public readonly events: Listenable<ForestEvents> = this.#events;

	/**
	 * @param roots - dummy node above the root under which detached fields are stored. All content of the forest is reachable from this.
	 * @param schema - schema which all content in this forest is assumed to comply with.
	 * @param chunker - Chunking policy. TODO: dispose of this when forest is disposed.
	 * @param anchors - anchorSet used to track location in this forest across changes. Callers of applyDelta must ensure this is updated accordingly.
	 */
	public constructor(
		roots: BasicChunk,
		public readonly schema: TreeStoredSchemaSubscription,
		public readonly chunker: IChunker,
		public readonly anchors: AnchorSet = new AnchorSet(),
		public readonly idCompressor?: IIdCompressor,
		public readonly breaker: Breakable = new Breakable("ChunkedForest"),
	) {
		this.rootSequence = new ChunkSequence([roots]);
	}

	public get isEmpty(): boolean {
		this.breaker.use();
		return this.roots.fields.size === 0;
	}

	public clone(schema: TreeStoredSchemaSubscription, breaker?: Breakable): ChunkedForest {
		this.breaker.use();
		assert(this.activeVisitor === undefined, "Cannot clone a forest with an acquired visitor");
		this.roots.referenceAdded();
		return new ChunkedForest(
			this.roots,
			schema,
			this.chunker.clone(schema),
			undefined,
			this.idCompressor,
			breaker ?? this.breaker,
		);
	}

	public chunkField(cursor: ITreeCursorSynchronous): TreeChunk[] {
		this.breaker.use();
		return chunkField(cursor, { idCompressor: this.idCompressor, policy: this.chunker });
	}

	public forgetAnchor(anchor: Anchor): void {
		this.anchors.forget(anchor);
	}

	public registerAnnouncedVisitor(visitor: () => AnnouncedVisitor): void {
		this.deltaVisitors.add(visitor);
	}

	public deregisterAnnouncedVisitor(visitor: () => AnnouncedVisitor): void {
		this.deltaVisitors.delete(visitor);
	}

	public acquireVisitor(): DeltaVisitor {
		this.breaker.use();
		assert(
			this.activeVisitor === undefined,
			0x76a /* Must release existing visitor before acquiring another */,
		);

		const rootSequenceEditor = this.rootSequence.acquireEditor();
		const rootEdit = rootSequenceEditor.acquireChild(0);
		const rootChunk = rootEdit.chunk;
		assert(rootChunk instanceof BasicChunk, "Forest root must be a basic chunk");
		const mutableChunkStack: StackNode[] = [];
		let mutableChunk: BasicChunk | undefined = rootChunk;
		let nodeEditor: ChunkEdit | undefined = rootEdit;
		const compressor: ChunkCompressor = {
			policy: this.chunker,
			idCompressor: this.idCompressor,
		};

		// Retain the exclusive owning path as the visitor advances.
		// Stable-length BasicChunk capabilities permit reads between visitor operations.
		const withRoot = <T>(callback: (root: BasicChunk, editor: ChunkEdit) => T): T =>
			callback(rootChunk, rootEdit);
		const withField = <T>(
			callback: (
				root: BasicChunk,
				rootEditor: ChunkEdit,
				parent: BasicChunk,
				field: ChunkSequenceEditor,
				key: FieldKey,
			) => T,
		): T => {
			assert(mutableChunk === undefined, "Visitor must be in a field");
			const parent = mutableChunkStack.at(-1) ?? oob();
			return callback(
				rootChunk,
				rootEdit,
				parent.mutableChunk,
				parent.fieldEditor,
				parent.key,
			);
		};

		// The `CombinableVisitor` which can apply deltas to this forest.
		// Annoyingly declaring the type here or in a satisfies clause causes this code not to build,
		// so the type is inferred.
		//
		// This visitor works by shallow copying (where needed) the forest as it's walked down
		// to ensure the location being traversed (and thus possibly edited) is an exclusively owned BasicChunk.
		// Future optimizations may improve this, but currently that is a requirement for the editing code to work.
		const forestVisitor = {
			forest: this,
			free(): void {
				assert(
					this.forest.activeVisitor !== undefined,
					0x76b /* Multiple free calls for same visitor */,
				);
				if (nodeEditor !== undefined && nodeEditor !== rootEdit) {
					nodeEditor.close();
				}
				for (let index = mutableChunkStack.length - 1; index >= 0; index--) {
					const frame = mutableChunkStack[index] ?? oob();
					frame.fieldEditor.close();
					if (frame.nodeEditor !== rootEdit) {
						frame.nodeEditor.close();
					}
				}
				rootEdit.close();
				rootSequenceEditor.close();
				mutableChunkStack.length = 0;
				mutableChunk = undefined;
				nodeEditor = undefined;
				this.forest.activeVisitor = undefined;
			},
			destroy(detachedField: FieldKey, count: number): void {
				this.forest.#events.emit("beforeChange");
				withRoot((root, editor) => {
					const field = root.fields.get(detachedField);
					assert(field !== undefined, 0xd1d /* Destroyed field must exist */);
					assert(
						getFieldLength(field) === count,
						0xd1e /* Destroy count must match field length */,
					);
					for (const chunk of root.takeField(editor, detachedField)) {
						chunk.referenceRemoved();
					}
				});
			},
			create(content: readonly ITreeCursorSynchronous[], destination: FieldKey): void {
				this.forest.#events.emit("beforeChange");
				withRoot((root, editor) => {
					assert(
						!root.fields.has(destination),
						0xd1f /* Create destination must be a new empty field */,
					);
					const chunks: TreeChunk[] = content.map((c) => chunkTree(c, compressor));
					root.createField(editor, destination, chunks);
				});
				this.forest.#events.emit("afterRootFieldCreated", destination);
			},
			attach(source: FieldKey, count: number, destination: PlaceIndex): void {
				this.attachEdit(source, count, destination);
			},
			detach(source: Range, destination: FieldKey, id: DeltaDetachedNodeId): void {
				this.detachEdit(source, destination);
			},
			/**
			 * Attaches the range into the current field by transferring it from the given source path.
			 * Does not invalidate dependents.
			 * @param source - The the range to be attached.
			 * @param destination - The index in the current field at which to attach the content.
			 */
			attachEdit(source: FieldKey, count: number, destination: PlaceIndex): void {
				this.forest.#events.emit("beforeChange");
				withField((root, rootEditor, parent, destinationField, key) => {
					assert(
						parent !== root || key !== source,
						0xd20 /* Attach source field must be different from current field */,
					);
					const sourceField = root.fields.get(source);
					assert(sourceField !== undefined, 0xd21 /* Attach source field must exist */);
					assert(
						getFieldLength(sourceField) === count,
						0xd22 /* Attach must consume all nodes in source field */,
					);
					assert(
						destination <= getFieldLength(destinationField.chunks),
						0xd23 /* Attach destination must not exceed field length */,
					);
					const destinationChunkIndex = splitFieldAtIndex(destinationField, destination, {
						policy: this.forest.chunker,
						idCompressor: this.forest.idCompressor,
					});
					const transferred = root.takeField(rootEditor, source);
					destinationField.splice(destinationChunkIndex, 0, transferred);
					// Coalesce the seams the splice may have created: one chunk to the left of the
					// insertion, the inserted chunks themselves, and one chunk to the right.
					const coalesceStart = Math.max(0, destinationChunkIndex - 1);
					const coalesceEnd = Math.min(
						destinationField.chunks.length,
						destinationChunkIndex + transferred.length + 1,
					);
					coalesceUniformChunks(destinationField, this.forest.chunker, {
						start: coalesceStart,
						end: coalesceEnd,
					});
				});
			},
			/**
			 * Detaches the range from the current field and transfers it to the given destination if any.
			 * Does not invalidate dependents.
			 * @param source - The bounds of the range to be detached from the current field.
			 * @param destination - If specified, the destination to transfer the detached range to.
			 * If not specified, the detached range is destroyed.
			 */
			detachEdit(source: Range, destination: FieldKey | undefined): void {
				// TODO: optimize this to perform in-place replace in uniform chunks when attach edits bring the chunk back to its original shape.
				// This should result in 3 cases:
				// 1. In-place update of uniform chunk. No allocations, no ref count changes, no new TreeChunks.
				// 2. Uniform chunk is shared: copy it (and parent path as needed), and update the copy.
				// 3. Fallback to detach then attach (Which will copy parents and convert to basic chunks as needed).

				this.forest.#events.emit("beforeChange");
				withField((root, rootEditor, parent, sourceField, key) => {
					assert(
						source.start <= source.end,
						0xd24 /* Detach range start must not exceed end */,
					);
					assert(
						source.end <= getFieldLength(sourceField.chunks),
						0xd25 /* Detach range must not exceed field length */,
					);
					if (destination !== undefined) {
						assert(
							parent !== root || key !== destination,
							0xd26 /* Detach destination field must be different from current field */,
						);
						assert(
							!root.fields.has(destination),
							0xd27 /* Detach destination must be a new empty field */,
						);
					}

					const policy: ChunkCompressor = {
						policy: this.forest.chunker,
						idCompressor: this.forest.idCompressor,
					};
					// Split start first: splitting end later only expands chunks at positions >= startChunkIndex,
					// which leaves startChunkIndex valid. The reverse order would shift endChunkIndex when
					// source.start and source.end land in different chunks.
					// Performance: It's practical to have a variant of splitFieldAtIndex which can split at multiple locations in a single pass if the performance of this becomes worth optimizing.
					const startChunkIndex = splitFieldAtIndex(sourceField, source.start, policy);
					const endChunkIndex = splitFieldAtIndex(sourceField, source.end, policy);
					const newField = sourceField.splice(
						startChunkIndex,
						endChunkIndex - startChunkIndex,
					);
					// After the detach, the only newly-adjacent seam is between the chunks on either
					// side of the removed range.
					const coalesceStart = Math.max(0, startChunkIndex - 1);
					const coalesceEnd = Math.min(sourceField.chunks.length, startChunkIndex + 1);
					coalesceUniformChunks(sourceField, this.forest.chunker, {
						start: coalesceStart,
						end: coalesceEnd,
					});

					if (destination === undefined) {
						for (const child of newField) {
							child.referenceRemoved();
						}
					} else {
						if (newField.length > 0) {
							root.createField(rootEditor, destination, newField);
						}
					}
					// Empty fields are removed after the transfer when their edit scope closes.
				});
			},
			/**
			 * Ensure the selected node (by `index`) is an exclusively owned basic node,
			 * and record its location for subsequent edits.
			 */
			enterNode(index: number): void {
				assert(mutableChunk === undefined, 0x535 /* should be in field */);
				const parent = mutableChunkStack.at(-1) ?? oob();
				// Get the mutable parent, which we might have to modify to ensure the desired child is an exclusively owned (and thus mutable) BasicChunk.
				const result = ensureExclusiveBasicChunk(parent.fieldEditor, index, compressor);
				mutableChunk = result.chunk;
				nodeEditor = parent.fieldEditor.acquireChild(result.indexOfChunk);
			},
			exitNode(index: number): void {
				assert(mutableChunk !== undefined, 0x537 /* should be in node */);
				assert(nodeEditor !== undefined && nodeEditor !== rootEdit, "Must exit a child node");
				nodeEditor.close();
				nodeEditor = undefined;
				mutableChunk = undefined;
			},
			enterField(key: FieldKey): void {
				assert(mutableChunk !== undefined, 0x538 /* should be in node */);
				assert(nodeEditor !== undefined, "Node must have a mutation capability");
				const fieldEditor = mutableChunk.acquireField(nodeEditor, key);
				mutableChunkStack.push({ mutableChunk, nodeEditor, fieldEditor, key });
				nodeEditor = undefined;
				mutableChunk = undefined;
			},
			exitField(key: FieldKey): void {
				assert(mutableChunk === undefined, 0x539 /* should be in field */);
				const parent = mutableChunkStack.pop() ?? oob();
				parent.fieldEditor.close();
				mutableChunk = parent.mutableChunk;
				nodeEditor = parent.nodeEditor;
			},
		};

		const announcedVisitors: AnnouncedVisitor[] = [];
		for (const getVisitor of this.deltaVisitors) {
			announcedVisitors.push(getVisitor());
		}
		const visitor = combineVisitors([
			makeBreakingVisitor(forestVisitor, this.breaker),
			...announcedVisitors,
		]);
		this.activeVisitor = visitor;
		return visitor;
	}

	private nextDetachedFieldIdentifier = 0;
	public newDetachedField(): DetachedField {
		const field: DetachedField = brand(String(this.nextDetachedFieldIdentifier));
		assert(
			!this.roots.fields.has(detachedFieldAsKey(field)),
			0x53a /* new field must not already exist */,
		);
		this.nextDetachedFieldIdentifier += 1;
		return field;
	}

	public allocateCursor(): Cursor {
		this.breaker.use();
		return new Cursor(
			this,
			ITreeSubscriptionCursorState.Cleared,
			[],
			[],
			[],
			[],
			[],
			[],
			0,
			0,
			0,
			undefined,
		);
	}

	public tryMoveCursorToNode(
		destination: Anchor,
		cursorToMove: ITreeSubscriptionCursor,
	): TreeNavigationResult {
		this.breaker.use();
		const path = this.anchors.locate(destination);
		if (path === undefined) {
			return TreeNavigationResult.NotFound;
		}
		this.moveCursorToPath(path, cursorToMove);
		return TreeNavigationResult.Ok;
	}

	public tryMoveCursorToField(
		destination: FieldAnchor,
		cursorToMove: ITreeSubscriptionCursor,
	): TreeNavigationResult {
		this.breaker.use();
		assert(
			cursorToMove instanceof Cursor,
			0x53b /* ChunkedForest must only be given its own Cursor type */,
		);
		if (destination.parent === undefined) {
			cursorToMove.setToDetachedSequence(destination.fieldKey);
			return TreeNavigationResult.Ok;
		}
		const result = this.tryMoveCursorToNode(destination.parent, cursorToMove);
		if (result !== TreeNavigationResult.Ok) {
			return result;
		}

		cursorToMove.enterField(destination.fieldKey);
		return TreeNavigationResult.Ok;
	}

	public moveCursorToPath(destination: UpPath, cursorToMove: ITreeSubscriptionCursor): void {
		this.breaker.use();
		assert(
			cursorToMove instanceof Cursor,
			0x53c /* ChunkedForest must only be given its own Cursor type */,
		);
		assert(
			cursorToMove.forest === this,
			0x53d /* ChunkedForest must only be given its own Cursor */,
		);

		const indexStack: number[] = [];
		const keyStack: FieldKey[] = [];

		let path: UpPath | undefined = destination;
		while (path !== undefined) {
			indexStack.push(path.parentIndex);
			keyStack.push(path.parentField);
			path = path.parent;
		}
		cursorToMove.clear();
		while (keyStack.length > 0) {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const key = keyStack.pop()!;
			if (cursorToMove.state === ITreeSubscriptionCursorState.Cleared) {
				cursorToMove.setToDetachedSequence(key);
				cursorToMove.state = ITreeSubscriptionCursorState.Current;
			} else {
				cursorToMove.enterField(key);
			}

			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			cursorToMove.enterNode(indexStack.pop()!);
		}
	}

	public getCursorAboveDetachedFields(): ITreeCursorSynchronous {
		this.breaker.use();
		const rootCursor = this.roots.cursor();
		rootCursor.enterNode(0);
		return rootCursor;
	}
}

class Cursor extends BasicChunkCursor implements ITreeSubscriptionCursor {
	public constructor(
		public readonly forest: ChunkedForest,
		public state: ITreeSubscriptionCursorState,
		root: readonly TreeChunk[],
		siblingStack: SiblingsOrKey[],
		indexStack: number[],
		indexOfChunkStack: number[],
		indexWithinChunkStack: number[],
		siblings: SiblingsOrKey,
		index: number,
		indexOfChunk: number,
		indexWithinChunk: number,
		nestedCursor: ChunkedCursor | undefined,
	) {
		super(
			root,
			siblingStack,
			indexStack,
			indexOfChunkStack,
			indexWithinChunkStack,
			siblings,
			index,
			indexOfChunk,
			indexWithinChunk,
			nestedCursor,
		);
	}

	public setToDetachedSequence(key: FieldKey): void {
		this.root = (this.forest.roots.fields.get(key) ?? []) as BasicChunk[];
		this.siblingStack.length = 0;
		this.indexStack.length = 0;
		this.indexOfChunkStack.length = 0;
		this.indexWithinChunkStack.length = 0;
		this.siblings = [key];
		this.index = 0;
		this.indexOfChunk = 0;
		this.indexWithinChunk = 0;
		this.nestedCursor = undefined;
	}

	public override fork(): Cursor {
		// Siblings arrays are not modified during navigation and do not need be be copied.
		// This allows this copy to be shallow, and `this.siblings` below to not be copied as all.
		return new Cursor(
			this.forest,
			this.state,
			this.root,
			[...this.siblingStack],
			[...this.indexStack],
			[...this.indexOfChunkStack],
			[...this.indexWithinChunkStack],
			this.siblings,
			this.index,
			this.indexOfChunk,
			this.indexWithinChunk,
			this.nestedCursor?.fork(),
		);
	}

	public buildFieldAnchor(): FieldAnchor {
		const path = this.getFieldPath();
		const anchor =
			path.parent === undefined ? undefined : this.forest.anchors.track(path.parent);
		return { parent: anchor, fieldKey: path.field };
	}

	public free(): void {
		this.state = ITreeSubscriptionCursorState.Freed;
	}

	public buildAnchor(): Anchor {
		return this.forest.anchors.track(this.getPath());
	}

	public clear(): void {
		this.state = ITreeSubscriptionCursorState.Cleared;
		this.setToDetachedSequence(rootFieldKey);
	}
}

/**
 * Creates an implementation of {@link IEditableForest} with no data or schema.
 */
export function buildChunkedForest(
	chunker: IChunker,
	anchors?: AnchorSet,
	idCompressor?: IIdCompressor,
	breaker?: Breakable,
): ChunkedForest {
	return new ChunkedForest(
		makeRoot(),
		chunker.schema,
		chunker,
		anchors,
		idCompressor,
		breaker,
	);
}
