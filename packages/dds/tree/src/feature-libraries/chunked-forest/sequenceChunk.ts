/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { type ChunkedCursor, type TreeChunk, dummyRoot } from "../../core/index.js";
import { BasicChunkCursor } from "./basicChunk.js";
import {
	type ChunkEdit,
	ChunkSequence,
	type ChunkSequenceEditor,
	MutableChunk,
} from "./chunkSequence.js";

/**
 * General purpose multi-node sequence chunk.
 */
export class SequenceChunk extends MutableChunk {
	private readonly children: ChunkSequence;

	public get subChunks(): readonly TreeChunk[] {
		return this.children.chunks;
	}

	public get topLevelLength(): number {
		return this.children.length;
	}

	/**
	 * Create a tree chunk with ref count 1.
	 *
	 * @param subChunks - Child references transferred to this object. The array is copied.
	 * The caller must have already accounted for these references (via `referenceAdded`).
	 * Edits must use an owner-issued editor, which maintains child ownership and indexes.
	 */
	public constructor(subChunks: readonly TreeChunk[]) {
		super();
		this.children = new ChunkSequence(subChunks, this);
	}

	public acquireChildren(editor: ChunkEdit): ChunkSequenceEditor {
		return this.children.acquireEditor(editor);
	}

	/** Consumes an external owning reference and returns independent ownership of the children. */
	public takeChildren(): TreeChunk[] {
		this.assertExternalOwnership();
		let chunks: TreeChunk[];
		if (this.isShared()) {
			chunks = this.subChunks.map((child) => {
				child.referenceAdded();
				return child;
			});
		} else {
			const editor = this.acquireEditor();
			const children = this.acquireChildren(editor);
			try {
				chunks = children.splice(0, children.chunks.length);
			} finally {
				children.close();
				editor.close();
			}
		}
		this.referenceRemoved();
		return chunks;
	}

	public clone(): SequenceChunk {
		this.assertReadable();
		const subChunks = this.subChunks.map((child) => {
			child.referenceAdded();
			return child;
		});
		return new SequenceChunk(subChunks);
	}

	public cursor(): ChunkedCursor {
		this.assertReadable();
		return new BasicChunkCursor(
			this.subChunks,
			[],
			[],
			[],
			[],
			[dummyRoot],
			0,
			0,
			0,
			undefined,
		);
	}

	protected onUnreferenced(): void {
		this.children.dispose();
	}
}
