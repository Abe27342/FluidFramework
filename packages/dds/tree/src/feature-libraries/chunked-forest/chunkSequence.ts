/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert, oob } from "@fluidframework/core-utils/internal";

import type { ChunkedCursor, TreeChunk } from "../../core/index.js";
import { ReferenceCountedBase, replaceArrayRange } from "../../util/index.js";

const ownershipKey = Symbol("chunk ownership");

/**
 * Minimum chunk count for cumulative-length indexing.
 * Chunk count, rather than node count, bounds the cost of a scan.
 */
export const chunkIndexThreshold = 128;

// This only associates borrowed arrays with their owners. The owners hold and invalidate the indexes.
const sequences = new WeakMap<readonly TreeChunk[], ChunkSequence>();

/** Shares the read barrier for an edit family without walking ancestor capabilities. */
class ChunkMutationState {
	private mutations = 0;

	public assertReadable(): void {
		assert(this.mutations === 0, "Cannot read chunks during a sequence mutation");
	}

	public change(key: typeof ownershipKey, delta: 1 | -1): void {
		assert(key === ownershipKey, "Invalid ownership authority");
		this.mutations += delta;
		assert(this.mutations >= 0, "Invalid mutation scope");
	}
}

/**
 * Base for chunks whose contents can change.
 * An owning reference outside a sequence can acquire an editor when the chunk is exclusive.
 * Contained chunks can only be edited through their sequence, after copy-on-write down the owning path.
 */
export abstract class MutableChunk extends ReferenceCountedBase implements TreeChunk {
	#externalReferences = 1;
	#editor: ChunkEdit | undefined;

	public abstract readonly topLevelLength: number;
	public abstract cursor(): ChunkedCursor;
	public abstract clone(): MutableChunk;

	/** Whether this chunk's contribution to its parent is constant for its lifetime. */
	public hasStableTopLevelLength(): boolean {
		return false;
	}

	public override referenceAdded(count = 1): void {
		assert(this.#editor === undefined, "Cannot share a chunk during an edit");
		assert(!this.isUnreferenced(), "Cannot retain a released chunk");
		super.referenceAdded(count);
		this.#externalReferences += count;
	}

	public override referenceRemoved(count = 1): void {
		assert(this.#editor === undefined, "Cannot release a chunk during an edit");
		assert(
			count <= this.#externalReferences,
			"Cannot release a reference owned by a sequence",
		);
		this.#externalReferences -= count;
		super.referenceRemoved(count);
	}

	/**
	 * Borrows exclusive mutation authority from an external owning reference.
	 * The caller must clone a shared chunk first, and must close the editor before sharing or transferring it.
	 */
	public acquireEditor(): ChunkEdit {
		this.assertExternalOwnership();
		return this.openEditor(ownershipKey);
	}

	/** Checks that a caller can transfer an owning reference not held by a sequence. */
	public assertExternalOwnership(): void {
		assert(
			this.#externalReferences > 0,
			"Contained chunks must be edited through their owner",
		);
		assert(this.#editor === undefined, "Cannot transfer a chunk during an edit");
	}

	/** Only sequence ownership operations can supply `ownershipKey`. */
	public changeOwnership(key: typeof ownershipKey, externalDelta: number): void {
		assert(key === ownershipKey, "Invalid ownership authority");
		assert(this.#editor === undefined, "Cannot transfer a chunk during an edit");
		assert(
			this.#externalReferences + externalDelta >= 0,
			"Cannot transfer a reference already owned by a sequence",
		);
		this.#externalReferences += externalDelta;
	}

	/** Only sequence editors can supply `ownershipKey`. */
	public openEditor(key: typeof ownershipKey, parent?: ChunkSequenceEditor): ChunkEdit {
		assert(key === ownershipKey, "Invalid ownership authority");
		assert(!this.isUnreferenced(), "Cannot edit a released chunk");
		assert(!this.isShared(), "Cannot edit a shared chunk");
		assert(this.#editor === undefined, "Chunk already has an editor");
		this.#editor = new ChunkEdit(ownershipKey, this, parent);
		return this.#editor;
	}

	/** Only edit scopes can supply `ownershipKey`. */
	public closeEditor(key: typeof ownershipKey, editor: ChunkEdit): void {
		assert(key === ownershipKey && this.#editor === editor, "Invalid chunk editor");
		this.#editor = undefined;
	}

	protected assertReadable(): void {
		assert(
			this.#editor === undefined || this.hasStableTopLevelLength(),
			"Cannot create a cursor during an edit",
		);
		this.#editor?.assertReadable();
	}

	protected assertCloneable(): void {
		assert(this.#editor === undefined, "Cannot clone a chunk during an edit");
	}
}

/**
 * A scoped mutation capability. Closing it revokes all future use.
 * A capability for a contained chunk is valid only while its owning sequence's editor is active.
 */
export class ChunkEdit {
	private active = true;
	private childScopes = 0;
	public readonly mutationState: ChunkMutationState;

	public constructor(
		key: typeof ownershipKey,
		public readonly chunk: MutableChunk,
		private readonly parent?: ChunkSequenceEditor,
	) {
		assert(key === ownershipKey, "Invalid ownership authority");
		parent?.changeChildScopes(ownershipKey, 1, chunk);
		this.mutationState = parent?.mutationState ?? new ChunkMutationState();
	}

	public assertFor(chunk: MutableChunk): void {
		assert(this.active && this.chunk === chunk, "Invalid or expired chunk editor");
		// Live children prevent their parents from closing, sharing, or transferring ownership.
		assert(!chunk.isShared(), "Cannot edit a shared chunk");
	}

	public assertReadable(): void {
		this.assertFor(this.chunk);
		this.mutationState.assertReadable();
	}

	/** Only field editors can supply `ownershipKey`. */
	public changeChildScopes(key: typeof ownershipKey, delta: number): void {
		assert(key === ownershipKey, "Invalid ownership authority");
		this.assertFor(this.chunk);
		this.childScopes += delta;
	}

	public close(): void {
		this.assertFor(this.chunk);
		assert(this.childScopes === 0, "Close child editors before their parent");
		this.active = false;
		this.chunk.closeEditor(ownershipKey, this);
		this.parent?.changeChildScopes(ownershipKey, -1, this.chunk);
	}
}

/**
 * Owns a sequence's chunk references and cumulative lengths.
 * Constructor input containers are copied; their chunk references are transferred, not retained.
 */
export class ChunkSequence {
	private readonly data: TreeChunk[];
	#index: readonly number[] | undefined;
	#length: number | undefined;
	#editor: ChunkSequenceEditor | undefined;
	#disposed = false;
	#failed = false;
	readonly #owner: MutableChunk | undefined;

	public constructor(chunks: readonly TreeChunk[], owner?: MutableChunk) {
		this.#owner = owner;
		this.data = [...chunks];
		for (const chunk of this.data) {
			adopt(chunk);
		}
		sequences.set(this.data, this);
	}

	/** Borrowed view. Reads require a coherent sequence and no length-changing child editor. */
	public get chunks(): readonly TreeChunk[] {
		this.assertReadable();
		return this.data;
	}

	public get length(): number {
		this.assertReadable();
		if (this.#length === undefined) {
			const index = this.getIndex();
			this.#length =
				index === undefined
					? this.data.reduce((total, chunk) => total + chunk.topLevelLength, 0)
					: (index.at(-1) ?? oob());
		}
		return this.#length;
	}

	public getIndex(): readonly number[] | undefined {
		this.assertReadable();
		if (this.data.length < chunkIndexThreshold) {
			return undefined;
		}
		if (this.#index === undefined) {
			let total = 0;
			this.#index = this.data.map((chunk) => {
				total += chunk.topLevelLength;
				return total;
			});
		}
		return this.#index;
	}

	/**
	 * Opens a synchronous edit scope. Metadata is invalidated before structural changes or length-changing child edits.
	 * When this sequence is contained, its owner's editor is required.
	 */
	public acquireEditor(
		parent?: ChunkEdit,
		onClose?: () => void,
		onChange?: (chunks: readonly TreeChunk[]) => void,
	): ChunkSequenceEditor {
		this.assertReadable();
		assert(this.#editor === undefined, "Sequence already has an editor");
		if (this.#owner === undefined) {
			assert(parent === undefined, "Unexpected parent editor");
		} else {
			assert(parent !== undefined, "Contained sequences require their owner's editor");
			parent.assertFor(this.#owner);
		}
		this.#editor = new ChunkSequenceEditor(
			ownershipKey,
			this,
			this.data,
			parent,
			onClose,
			onChange,
		);
		return this.#editor;
	}

	public edit<T>(callback: (editor: ChunkSequenceEditor) => T, parent?: ChunkEdit): T {
		const editor = this.acquireEditor(parent);
		try {
			return callback(editor);
		} finally {
			editor.close();
		}
	}

	/** Transfers all references out and revokes this container. */
	public takeChunks(parent?: ChunkEdit): TreeChunk[] {
		const chunks = this.edit((editor) => editor.splice(0, editor.chunks.length), parent);
		this.dispose();
		return chunks;
	}

	public dispose(): void {
		this.assertReadable();
		assert(this.#editor === undefined, "Cannot dispose a sequence during an edit");
		this.#disposed = true;
		for (const chunk of this.data) {
			release(chunk);
			chunk.referenceRemoved();
		}
		this.data.length = 0;
		this.#index = undefined;
		this.#length = undefined;
		sequences.delete(this.data);
	}

	/** Only edit scopes can supply `ownershipKey`. */
	public closeEditor(key: typeof ownershipKey, editor: ChunkSequenceEditor): void {
		assert(key === ownershipKey && this.#editor === editor, "Invalid sequence editor");
		this.#editor = undefined;
	}

	/** Only edit scopes can supply `ownershipKey`. */
	public markFailed(key: typeof ownershipKey): void {
		assert(key === ownershipKey, "Invalid ownership authority");
		this.#failed = true;
	}

	/** Only edit scopes can supply `ownershipKey`. */
	public invalidate(key: typeof ownershipKey): void {
		assert(key === ownershipKey, "Invalid ownership authority");
		this.#index = undefined;
		this.#length = undefined;
	}

	private assertReadable(): void {
		assert(!this.#disposed, "Sequence ownership has been released");
		assert(!this.#failed, "Sequence edit failed");
		this.#editor?.assertReadable();
	}
}

/**
 * Edits a sequence and borrows mutation authority for its children.
 * Splices transfer references; callers must release removed references they do not reuse.
 */
export class ChunkSequenceEditor {
	private active = true;
	private childScopes = 0;
	private unstableChildScopes = 0;
	private splicing = false;
	private transforming = false;
	private failed = false;
	public readonly mutationState: ChunkMutationState;

	public constructor(
		key: typeof ownershipKey,
		private readonly sequence: ChunkSequence,
		private readonly data: TreeChunk[],
		private readonly parent?: ChunkEdit,
		private readonly onClose?: () => void,
		private readonly onChange?: (chunks: readonly TreeChunk[]) => void,
	) {
		assert(key === ownershipKey, "Invalid ownership authority");
		parent?.changeChildScopes(ownershipKey, 1);
		this.mutationState = parent?.mutationState ?? new ChunkMutationState();
	}

	public assertActive(): void {
		assert(this.active, "Expired sequence editor");
		assert(!this.transforming, "Cannot access a sequence during a range transformation");
		assert(!this.splicing, "Cannot access a sequence during a splice");
		assert(!this.failed, "Sequence edit failed");
	}

	/** Stable-length child capabilities do not prevent reads between sequence mutations. */
	public assertReadable(): void {
		this.assertActive();
		this.mutationState.assertReadable();
		assert(
			this.unstableChildScopes === 0,
			"Cannot read a sequence during an edit of a variable-length child",
		);
	}

	public get chunks(): readonly TreeChunk[] {
		this.assertActive();
		return this.data;
	}

	public splice(
		start: number,
		deleteCount: number,
		inserted: readonly TreeChunk[] = [],
	): TreeChunk[] {
		this.assertActive();
		assert(this.childScopes === 0, "Cannot transfer chunks with active child editors");
		assert(
			Number.isSafeInteger(start) &&
				Number.isSafeInteger(deleteCount) &&
				start >= 0 &&
				deleteCount >= 0 &&
				start + deleteCount <= this.data.length,
			"Invalid chunk splice range",
		);
		const removed = this.data.slice(start, start + deleteCount);
		this.splicing = true;
		this.mutationState.change(ownershipKey, 1);
		try {
			this.sequence.invalidate(ownershipKey);
			for (const chunk of inserted) {
				adopt(chunk);
			}
			for (const chunk of removed) {
				release(chunk);
			}
			replaceArrayRange(this.data, start, start + deleteCount, inserted);
			this.onChange?.(this.data);
			return removed;
		} finally {
			this.splicing = false;
			this.mutationState.change(ownershipKey, -1);
		}
	}

	/**
	 * Transfers a range to a synchronous transformation, then adopts its result.
	 * The backing array is replaced once, even when the transform coalesces many chunks in place.
	 * This is not a rollback boundary: a failed transform must not be followed by further use.
	 */
	public transformRange(
		start: number,
		end: number,
		transform: (chunks: TreeChunk[]) => readonly TreeChunk[],
	): void {
		this.assertActive();
		assert(this.childScopes === 0, "Cannot transfer chunks with active child editors");
		assert(
			Number.isSafeInteger(start) &&
				Number.isSafeInteger(end) &&
				start >= 0 &&
				end >= start &&
				end <= this.data.length,
			"Invalid transform range",
		);
		const input = this.data.slice(start, end);
		this.sequence.invalidate(ownershipKey);
		this.transforming = true;
		this.mutationState.change(ownershipKey, 1);
		let completed = false;
		try {
			for (const chunk of input) {
				release(chunk);
			}
			const output = transform(input);
			for (const chunk of output) {
				adopt(chunk);
			}
			replaceArrayRange(this.data, start, end, output);
			this.onChange?.(this.data);
			completed = true;
		} finally {
			this.transforming = false;
			this.mutationState.change(ownershipKey, -1);
			if (!completed) {
				this.failed = true;
				this.sequence.markFailed(ownershipKey);
			}
		}
	}

	/** Copies a shared child before opening its mutation scope. */
	public acquireChild(index: number): ChunkEdit {
		this.assertActive();
		const child = this.data[index] ?? oob();
		assert(child instanceof MutableChunk, "Chunk does not support controlled mutation");
		let chunk: MutableChunk = child;
		if (chunk.isShared()) {
			const copy = chunk.clone();
			assert(copy.topLevelLength === chunk.topLevelLength, "Clone must preserve chunk length");
			adopt(copy);
			release(chunk);
			this.data[index] = copy;
			chunk.referenceRemoved();
			chunk = copy;
		}
		if (!chunk.hasStableTopLevelLength()) {
			this.sequence.invalidate(ownershipKey);
		}
		return chunk.openEditor(ownershipKey, this);
	}

	public editChild<T>(index: number, callback: (editor: ChunkEdit) => T): T {
		const editor = this.acquireChild(index);
		try {
			return callback(editor);
		} finally {
			editor.close();
		}
	}

	/** Only child editors can supply `ownershipKey`. */
	public changeChildScopes(
		key: typeof ownershipKey,
		delta: number,
		chunk: MutableChunk,
	): void {
		assert(key === ownershipKey, "Invalid ownership authority");
		this.assertActive();
		this.childScopes += delta;
		if (!chunk.hasStableTopLevelLength()) {
			this.unstableChildScopes += delta;
		}
	}

	public close(): void {
		assert(
			this.active && !this.transforming && !this.splicing,
			"Invalid sequence editor close",
		);
		assert(this.childScopes === 0, "Close child editors before their parent");
		this.active = false;
		this.sequence.closeEditor(ownershipKey, this);
		this.parent?.changeChildScopes(ownershipKey, -1);
		if (!this.failed) {
			this.onClose?.();
		}
	}
}

function adopt(chunk: TreeChunk): void {
	if (chunk instanceof MutableChunk) {
		chunk.changeOwnership(ownershipKey, -1);
	}
}

function release(chunk: TreeChunk): void {
	if (chunk instanceof MutableChunk) {
		chunk.changeOwnership(ownershipKey, 1);
	}
}

/** Gets an owned sequence's index. Unowned arrays are never cached. */
export function getChunkIndex(chunks: readonly TreeChunk[]): readonly number[] | undefined {
	return sequences.get(chunks)?.getIndex();
}

/** Finds the first cumulative end offset greater than `nodeIndex`. */
export function findChunkIndex(index: readonly number[], nodeIndex: number): number {
	let low = 0;
	let high = index.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (nodeIndex < (index[mid] ?? oob())) {
			high = mid;
		} else {
			low = mid + 1;
		}
	}
	return low;
}
