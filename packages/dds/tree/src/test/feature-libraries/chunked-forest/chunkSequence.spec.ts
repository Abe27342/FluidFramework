/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import { makeRandom } from "@fluid-private/stochastic-test-utils";

import { EmptyKey, type TreeChunk } from "../../../core/index.js";
// eslint-disable-next-line import-x/no-internal-modules
import { BasicChunk } from "../../../feature-libraries/chunked-forest/basicChunk.js";
import {
	ChunkSequence,
	type ChunkEdit,
	type ChunkSequenceEditor,
	chunkIndexThreshold,
	getChunkIndex,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../feature-libraries/chunked-forest/chunkSequence.js";
import {
	coalesceUniformChunks,
	defaultChunkPolicy,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../feature-libraries/chunked-forest/chunkTree.js";
// eslint-disable-next-line import-x/no-internal-modules
import { deaggregateChunks } from "../../../feature-libraries/chunked-forest/codec/chunkDecoding.js";
// eslint-disable-next-line import-x/no-internal-modules
import { SequenceChunk } from "../../../feature-libraries/chunked-forest/sequenceChunk.js";
import {
	TreeShape,
	UniformChunk,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../../feature-libraries/chunked-forest/uniformChunk.js";
import { brand } from "../../../util/index.js";

const shape = new TreeShape(brand("number"), true, []);

function numberChunk(value: number): UniformChunk {
	return new UniformChunk(shape.withTopLevelLength(1), [value]);
}

function editSequence<T>(
	chunk: SequenceChunk,
	callback: (editor: ChunkSequenceEditor) => T,
): T {
	const edit = chunk.acquireEditor();
	const children = chunk.acquireChildren(edit);
	try {
		return callback(children);
	} finally {
		children.close();
		edit.close();
	}
}

function append(editor: ChunkEdit, value: number): void {
	assert(editor.chunk instanceof UniformChunk);
	editor.chunk.append(editor, [value], 1);
}

function checkValues(chunk: TreeChunk, expected: readonly number[]): void {
	assert.equal(chunk.topLevelLength, expected.length);
	const cursor = chunk.cursor();
	assert.equal(cursor.getFieldLength(), expected.length);
	for (let index = expected.length - 1; index >= 0; index--) {
		cursor.enterNode(index);
		assert.equal(cursor.value, expected[index]);
		cursor.exitNode();
	}
}

describe("ChunkSequence ownership", () => {
	it("invalidates cached lengths when an exclusive contained chunk grows", () => {
		const values = Array.from({ length: chunkIndexThreshold }, (_, index) => index);
		const chunk = new SequenceChunk(values.map(numberChunk));
		checkValues(chunk, values);
		const borrowed = chunk.subChunks;
		const previousIndex = getChunkIndex(borrowed);

		editSequence(chunk, (children) => {
			children.editChild(0, (edit) => {
				assert.throws(() => getChunkIndex(borrowed), /during an edit/);
				append(edit, 999);
			});
		});

		values.splice(1, 0, 999);
		checkValues(chunk, values);
		assert.notEqual(getChunkIndex(chunk.subChunks), previousIndex);
		chunk.referenceRemoved();
	});

	it("extracts a chunk, changes its length outside a field, and adopts it into another field", () => {
		const values = Array.from({ length: chunkIndexThreshold }, (_, index) => index);
		const chunk = new SequenceChunk(values.map(numberChunk));
		const source = new ChunkSequence([chunk]);
		checkValues(chunk, values);
		assert.throws(() => chunk.acquireEditor(), /through their owner/);

		const removed = source.edit((editor) => editor.splice(0, 1));
		assert.equal(removed[0], chunk);
		assert.equal(source.length, 0);
		editSequence(chunk, (children) => children.editChild(0, (edit) => append(edit, 999)));
		values.splice(1, 0, 999);
		checkValues(chunk, values);

		const destination = new ChunkSequence(
			Array.from({ length: chunkIndexThreshold - 1 }, () => numberChunk(-1)),
		);
		destination.edit((editor) => editor.splice(0, 0, removed));
		assert.equal(destination.length, values.length + chunkIndexThreshold - 1);
		assert.throws(() => chunk.acquireEditor(), /through their owner/);
		source.dispose();
		destination.dispose();
		assert(chunk.isUnreferenced());
	});

	it("invalidates all affected nested sequence indexes before length-changing edits", () => {
		const bottom = new SequenceChunk(
			Array.from({ length: chunkIndexThreshold }, (_, index) => numberChunk(index)),
		);
		const middle = new SequenceChunk([
			bottom,
			...Array.from({ length: chunkIndexThreshold - 1 }, () => numberChunk(-1)),
		]);
		const outer = new SequenceChunk([
			middle,
			...Array.from({ length: chunkIndexThreshold - 1 }, () => numberChunk(-2)),
		]);
		const length = outer.topLevelLength;
		const arrays = [outer.subChunks, middle.subChunks, bottom.subChunks];
		const indexes = arrays.map(getChunkIndex);
		assert(indexes.every((index) => index !== undefined));

		editSequence(outer, (outerChildren) =>
			outerChildren.editChild(0, (middleEdit) => {
				assert(middleEdit.chunk instanceof SequenceChunk);
				const middleChildren = middleEdit.chunk.acquireChildren(middleEdit);
				try {
					middleChildren.editChild(0, (bottomEdit) => {
						assert(bottomEdit.chunk instanceof SequenceChunk);
						const bottomChildren = bottomEdit.chunk.acquireChildren(bottomEdit);
						try {
							bottomChildren.editChild(0, (edit) => append(edit, 999));
						} finally {
							bottomChildren.close();
						}
					});
				} finally {
					middleChildren.close();
				}
			}),
		);

		assert.equal(outer.cursor().getFieldLength(), length + 1);
		for (let index = 0; index < arrays.length; index++) {
			assert.notEqual(getChunkIndex(arrays[index]), indexes[index]);
		}
		outer.referenceRemoved();
	});

	it("copies shared ancestry before editing a singly referenced descendant", () => {
		const descendant = numberChunk(1);
		const parent = new SequenceChunk([descendant]);
		const original = new ChunkSequence([parent]);
		parent.referenceAdded();
		const fork = new ChunkSequence([parent]);
		assert.equal(descendant.isShared(), false);
		assert.throws(() => descendant.acquireEditor(), /through their owner/);
		assert.throws(() => descendant.referenceRemoved(), /owned by a sequence/);

		fork.edit((roots) =>
			roots.editChild(0, (parentEdit) => {
				assert(parentEdit.chunk instanceof SequenceChunk);
				const children = parentEdit.chunk.acquireChildren(parentEdit);
				try {
					children.editChild(0, (edit) => append(edit, 2));
				} finally {
					children.close();
				}
			}),
		);
		checkValues(original.chunks[0], [1]);
		checkValues(fork.chunks[0], [1, 2]);
		assert.equal(descendant.isShared(), false);
		original.dispose();
		fork.dispose();
		assert(descendant.isUnreferenced());
	});

	it("stops length invalidation at basic chunks", () => {
		const basic = new BasicChunk(brand("object"), new Map([[EmptyKey, [numberChunk(1)]]]));
		const roots = new ChunkSequence([
			basic,
			...Array.from({ length: chunkIndexThreshold - 1 }, () => numberChunk(0)),
		]);
		const index = roots.getIndex();
		roots.edit((sequence) =>
			sequence.editChild(0, (edit) => {
				assert(edit.chunk instanceof BasicChunk);
				const field = edit.chunk.acquireField(edit, EmptyKey);
				try {
					field.editChild(0, (childEdit) => append(childEdit, 2));
				} finally {
					field.close();
				}
			}),
		);
		assert.equal(roots.getIndex(), index);
		assert.equal(roots.length, chunkIndexThreshold);
		assert.equal(basic.fields.get(EmptyKey)?.[0].topLevelLength, 2);
		roots.dispose();
	});

	it("permits reads under stable-length capabilities without allowing ownership changes", () => {
		const basic = new BasicChunk(brand("object"), new Map([[EmptyKey, [numberChunk(1)]]]));
		const sequence = new ChunkSequence([basic]);
		const editor = sequence.acquireEditor();
		const node = editor.acquireChild(0);
		const field = basic.acquireField(node, EmptyKey);
		try {
			assert.equal(sequence.length, 1);
			assert.equal(sequence.chunks[0], basic);
			const cursor = basic.cursor();
			assert(cursor.firstNode());
			cursor.enterField(EmptyKey);
			assert.equal(cursor.getFieldLength(), 1);
			assert.throws(() => basic.clone(), /Cannot clone a chunk during an edit/);
			assert.throws(() => basic.referenceAdded(), /Cannot share a chunk during an edit/);
			assert.throws(() => sequence.acquireEditor(), /already has an editor/);
			assert.throws(() => sequence.dispose(), /Cannot dispose a sequence during an edit/);
			assert.throws(() => node.close(), /Close child editors/);
		} finally {
			field.close();
			node.close();
			editor.close();
		}
		sequence.dispose();
	});

	it("does not rebuild metadata until a variable-length child editor closes", () => {
		const sequence = new ChunkSequence(
			Array.from({ length: chunkIndexThreshold }, (_, index) => numberChunk(index)),
		);
		let previous = sequence.getIndex();
		sequence.edit((editor) => {
			assert.equal(sequence.getIndex(), previous);
			for (let iteration = 1; iteration <= 2; iteration++) {
				const child = editor.acquireChild(0);
				try {
					assert.throws(() => sequence.getIndex(), /variable-length child/);
					append(child, 999);
					assert.throws(() => sequence.length, /variable-length child/);
					assert.throws(() => sequence.chunks, /variable-length child/);
				} finally {
					child.close();
				}
				assert.equal(sequence.length, chunkIndexThreshold + iteration);
				assert.notEqual(sequence.getIndex(), previous);
				previous = sequence.getIndex();
			}
		});
		sequence.dispose();
	});

	it("rejects reads and reentrant access while a sequence splice is being published", () => {
		const sequence = new ChunkSequence([numberChunk(1)]);
		const editor = sequence.acquireEditor(undefined, undefined, () => {
			assert.throws(() => sequence.length, /during a splice/);
			assert.throws(() => editor.splice(0, 0), /during a splice/);
			assert.throws(() => editor.close(), /Invalid sequence editor close/);
		});
		try {
			editor.splice(1, 0, [numberChunk(2)]);
			assert.equal(sequence.length, 2);
		} finally {
			editor.close();
		}
		sequence.dispose();
	});

	it("rejects ordinary reads during a range transformation", () => {
		const sequence = new ChunkSequence([numberChunk(1)]);
		sequence.edit((editor) =>
			editor.transformRange(0, 1, (chunks) => {
				assert.throws(() => sequence.length, /range transformation/);
				assert.throws(() => sequence.chunks, /range transformation/);
				return chunks;
			}),
		);
		assert.equal(sequence.length, 1);
		sequence.dispose();
	});

	it("blocks cursor creation through an ancestor during a descendant sequence mutation", () => {
		const child = new BasicChunk(brand("child"), new Map([[EmptyKey, [numberChunk(1)]]]));
		const root = new BasicChunk(brand("root"), new Map([[EmptyKey, [child]]]));
		const rootEdit = root.acquireEditor();
		const rootField = root.acquireField(rootEdit, EmptyKey);
		const childEdit = rootField.acquireChild(0);
		const childField = child.acquireField(childEdit, EmptyKey);
		try {
			childField.transformRange(0, 1, (chunks) => {
				assert.throws(() => root.cursor(), /during a sequence mutation/);
				assert.throws(() => child.cursor(), /during a sequence mutation/);
				return chunks;
			});
			const cursor = root.cursor();
			assert(cursor.firstNode());
			cursor.enterField(EmptyKey);
			assert(cursor.firstNode());
			cursor.enterField(EmptyKey);
			assert.equal(cursor.getFieldLength(), 1);
		} finally {
			childField.close();
			childEdit.close();
			rootField.close();
			rootEdit.close();
			root.referenceRemoved();
		}
	});

	it("copies constructor containers instead of retaining writable aliases", () => {
		const values = [1];
		const uniform = new UniformChunk(shape.withTopLevelLength(1), values);
		values.push(999);
		const children: TreeChunk[] = [uniform];
		const fields = new Map([[EmptyKey, children]]);
		const basic = new BasicChunk(brand("object"), fields);
		children.length = 0;
		fields.clear();
		assert.equal(basic.fields.get(EmptyKey)?.length, 1);
		checkValues(uniform, [1]);
		assert.throws(() => uniform.acquireEditor(), /through their owner/);
		const input = [basic];
		const sequence = new SequenceChunk(input);
		input.length = 0;
		assert.equal(sequence.topLevelLength, 1);
		sequence.referenceRemoved();
		assert(uniform.isUnreferenced());
	});

	it("deaggregates shared wrappers without sharing a mutable container", () => {
		const first = numberChunk(1);
		const second = numberChunk(2);
		const sequence = new SequenceChunk([first, second]);
		sequence.referenceAdded();
		const children = deaggregateChunks(sequence);
		assert.notEqual(children, sequence.subChunks);
		children.reverse();
		checkValues(sequence, [1, 2]);
		for (const child of children) {
			child.referenceRemoved();
		}
		sequence.referenceRemoved();
		assert(first.isUnreferenced());
		assert(second.isUnreferenced());
	});

	it("revokes editors and prevents transfer or sharing while a child is writable", () => {
		const uniform = numberChunk(1);
		const sequence = new ChunkSequence([uniform]);
		const edit = sequence.acquireEditor();
		const child = edit.acquireChild(0);
		assert.throws(() => edit.close(), /Close child editors/);
		assert.throws(() => edit.splice(0, 1), /active child editors/);
		assert.throws(() => uniform.referenceAdded(), /during an edit/);
		child.close();
		edit.close();
		assert.throws(() => append(child, 2), /expired chunk editor/);
		assert.throws(() => edit.splice(0, 1), /Expired sequence editor/);
		const transferred = sequence.takeChunks();
		assert.throws(() => sequence.acquireEditor(), /ownership has been released/);
		for (const chunk of transferred) {
			chunk.referenceRemoved();
		}
	});

	it("reuses the accumulator and its value buffer for a long coalescing pass", () => {
		const chunks = Array.from({ length: 1000 }, (_, index) => numberChunk(index));
		const accumulator = chunks[0];
		const buffer = accumulator.values;
		const sequence = new ChunkSequence(chunks);
		assert.equal(sequence.length, chunks.length);
		sequence.edit((edit) =>
			coalesceUniformChunks(edit, {
				...defaultChunkPolicy,
				uniformChunkNodeCountDynamicTargetMax: chunks.length,
			}),
		);
		assert.equal(sequence.chunks.length, 1);
		assert.equal(sequence.chunks[0], accumulator);
		assert.equal(accumulator.values, buffer);
		assert.equal(buffer.length, chunks.length);
		assert(chunks.slice(1).every((chunk) => chunk.isUnreferenced()));
		sequence.dispose();
	});

	it("appends null values and can reuse its own value view", () => {
		const nullableShape = new TreeShape(brand("null"), true, []);
		// eslint-disable-next-line @rushstack/no-new-null
		const chunk = new UniformChunk(nullableShape.withTopLevelLength(1), [null]);
		const edit = chunk.acquireEditor();
		try {
			chunk.append(edit, chunk.values, 1);
		} finally {
			edit.close();
		}
		assert.equal(chunk.topLevelLength, 2);
		assert.equal(chunk.values.length, 2);
		assert.equal(chunk.values[0], chunk.values[1]);
		chunk.referenceRemoved();
	});

	it("rejects fractional range boundaries before transferring ownership", () => {
		const sequence = new ChunkSequence([numberChunk(1), numberChunk(2)]);
		sequence.edit((edit) => {
			for (const [start, end] of [
				[0.5, 1],
				[0, 1.5],
			]) {
				assert.throws(
					() => edit.transformRange(start, end, (chunks) => chunks),
					/Invalid transform range/,
				);
			}
		});
		assert.equal(sequence.length, 2);
		assert.deepEqual(
			sequence.chunks.map((chunk) => {
				assert(chunk instanceof UniformChunk);
				return chunk.values[0];
			}),
			[1, 2],
		);
		sequence.dispose();
	});

	it("does not expose success-shaped state after a failed range transformation", () => {
		const sequence = new ChunkSequence([numberChunk(1)]);
		const error = new Error("transform failed");
		assert.throws(
			() =>
				sequence.edit((edit) =>
					edit.transformRange(0, 1, () => {
						assert.throws(() => edit.splice(0, 0), /range transformation/);
						throw error;
					}),
				),
			(actual) => actual === error,
		);
		assert.throws(() => sequence.length, /Sequence edit failed/);
	});

	for (const seed of [0, 1, 2, 3, 4]) {
		it(`matches a reference model across sharing, moves, external edits, and coalescing (seed ${seed})`, () => {
			const random = makeRandom(seed);
			let nextValue = 0;
			const owners = Array.from({ length: 3 }, () => {
				const expected = Array.from({ length: chunkIndexThreshold }, () => nextValue++);
				return { chunk: new SequenceChunk(expected.map(numberChunk)), expected };
			});
			const makeExclusive = (index: number): (typeof owners)[number] => {
				const owner = owners[index];
				if (owner.chunk.isShared()) {
					const previous = owner.chunk;
					owner.chunk = previous.clone();
					previous.referenceRemoved();
				}
				return owner;
			};
			const nodeOffset = (chunks: readonly TreeChunk[], end: number): number =>
				chunks.slice(0, end).reduce((total, chunk) => total + chunk.topLevelLength, 0);

			try {
				for (let step = 0; step < 100; step++) {
					const sourceIndex = random.integer(0, owners.length - 1);
					const operation = random.integer(0, 4);
					if (operation === 0 && owners.length < 6) {
						const source = owners[sourceIndex];
						source.chunk.referenceAdded();
						owners.push({ chunk: source.chunk, expected: [...source.expected] });
					} else {
						const source = makeExclusive(sourceIndex);
						const count = source.chunk.subChunks.length;
						if (operation === 1 && count > 0) {
							const at = random.integer(0, count - 1);
							const offset = nodeOffset(source.chunk.subChunks, at + 1);
							const value = nextValue++;
							editSequence(source.chunk, (children) =>
								children.editChild(at, (edit) => append(edit, value)),
							);
							source.expected.splice(offset, 0, value);
						} else if (operation === 2 && count > 0) {
							const at = random.integer(0, count - 1);
							const offset = nodeOffset(source.chunk.subChunks, at);
							const length = source.chunk.subChunks[at].topLevelLength;
							const moved = editSequence(source.chunk, (children) => children.splice(at, 1));
							const expected = source.expected.splice(offset, length);
							const extracted = moved[0];
							assert(extracted instanceof UniformChunk);
							let external: UniformChunk = extracted;
							if (external.isShared()) {
								const copy = external.clone();
								external.referenceRemoved();
								external = copy;
							}
							const edit = external.acquireEditor();
							const value = nextValue++;
							append(edit, value);
							edit.close();
							expected.push(value);
							const targetIndex = (sourceIndex + 1) % owners.length;
							const target = makeExclusive(targetIndex);
							const insertAt = random.integer(0, target.chunk.subChunks.length);
							const targetOffset = nodeOffset(target.chunk.subChunks, insertAt);
							editSequence(target.chunk, (children) =>
								children.splice(insertAt, 0, [external]),
							);
							target.expected.splice(targetOffset, 0, ...expected);
						} else if (operation === 3 && count > 1) {
							const start = random.integer(0, count - 2);
							editSequence(source.chunk, (children) =>
								coalesceUniformChunks(children, defaultChunkPolicy, {
									start,
									end: Math.min(count, start + 5),
								}),
							);
						} else {
							const at = random.integer(0, count);
							const offset = nodeOffset(source.chunk.subChunks, at);
							const value = nextValue++;
							editSequence(source.chunk, (children) =>
								children.splice(at, 0, [numberChunk(value)]),
							);
							source.expected.splice(offset, 0, value);
						}
					}
					for (const owner of owners) {
						checkValues(owner.chunk, owner.expected);
					}
				}
			} finally {
				for (const owner of owners) {
					owner.chunk.referenceRemoved();
				}
			}
		});
	}
});
