/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/core-utils/internal";
import {
	type IdAllocator,
	type NestedMap,
	type RangeQueryResult,
	RangeMap,
	brand,
	idAllocatorFromMaxId,
	setInNestedMap,
} from "../../util/index.js";
import type { RevisionTag } from "../rebase/index.js";
import type { FieldKey } from "../schema-stored/index.js";

import type * as Delta from "./delta.js";
import type {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Used by TSDoc links.
	DetachedField,
	DetachedFieldRange,
	DetachedFieldSummaryData,
	DetachedFieldSummaryEntry,
	DetachedNodeLocation,
	DetachedNodeRange,
	ForestRootId,
	Major,
	Minor,
} from "./detachedFieldIndexTypes.js";
import { makeDetachedNodeId, offsetDetachId, subtractDetachedNodeId } from "./deltaUtil.js";
import type { Range } from "./pathTree.js";
import { getDetachedFieldSummaryRanges } from "./detachedFieldIndexValidation.js";

/**
 * Readonly view of the detached-node identity and forest-location mapping described by {@link DetachedFieldIndex}.
 * Queries use either detached node IDs or forest field IDs and node indices; these are distinct coordinate systems.
 */
export interface ReadOnlyDetachedFieldIndex {
	/**
	 * Creates a deep clone of this `DetachedFieldIndex`.
	 */
	clone(): DetachedFieldIndex;

	/**
	 * Returns a field key for the given ID.
	 * This does not save the field key on the index. To do so, call {@link DetachedFieldIndex.createRange}.
	 */
	toFieldKey(id: ForestRootId): FieldKey;

	/**
	 * Returns the forest field ID and node index for a detached node ID, or undefined if the ID is unknown.
	 */
	tryGetLocation(id: Delta.DetachedNodeId): DetachedNodeLocation | undefined;

	/**
	 * Returns the forest field ID and node index for a detached node ID. Fails if the ID is unknown.
	 */
	getLocation(id: Delta.DetachedNodeId): DetachedNodeLocation;

	/**
	 * Returns the number of roots in a registered forest field, including nonconsecutive ID runs.
	 */
	getFieldLength(root: ForestRootId): number;

	/**
	 * Returns the maximal prefix of the query at consecutive node indices in one forest field,
	 * or the maximal missing prefix if the first ID is unknown.
	 * Lifetime boundaries do not split the result.
	 * Within a present prefix, incrementing the detached node ID's minor component increments the node index by the same amount.
	 * @param id - The first detached node ID to query.
	 * @param count - The number of detached node IDs to query. Must be a positive safe integer.
	 */
	getFirst(
		id: Delta.DetachedNodeId,
		count: number,
	): RangeQueryResult<DetachedNodeLocation | undefined>;

	/**
	 * Returns runs of detached node IDs for a range of node indices in a forest field, in field order.
	 * Fails for unknown fields, out-of-bounds intervals, or untracked nodes.
	 * Run lengths sum to the interval's length, and adjacent runs with consecutive detached node IDs are combined.
	 */
	getFieldRanges(root: ForestRootId, range: Range): readonly DetachedNodeRange[];

	/**
	 * Enumerates compact records without expanding runs into individual nodes.
	 * Do not retain forest locations or continue this enumeration across index mutations.
	 */
	ranges(): Iterable<DetachedFieldRange>;
}

/**
 * Restores the originating DetachedFieldIndex to the state it was in when the checkpoint was created.
 * Can be invoked multiple times.
 */
export type DetachedFieldIndexCheckpoint = () => void;

/**
 * Tracks the identities, forest locations, and retention revisions of detached root nodes.
 * @remarks
 * A detached node ID combines an optional revision (`major`) with a node identifier scoped to that revision (`minor`).
 * A forest location is a field ID (`root`) and a zero-based node index within that field (`index`).
 * The field ID identifies the entire detached field, not an individual node or chunk.
 * {@link toFieldKey} converts it to the key used by forest visitors and cursors.
 *
 * A range record starting at `id`, with location `(root, index)` and length `count`,
 * maps each `{ major: id.major, minor: id.minor + offset }` to `(root, index + offset)` for `0 <= offset < count`.
 * Every node in a tracked field has exactly one detached node ID, and the records for that field cover its node indices without gaps or overlaps.
 * The index tracks only registered detached fields, not the document's root field or descendants within the detached subtrees.
 *
 * {@link createRange} reserves one new field ID and registers the whole field as one consecutive ID range starting at node index zero.
 * Removing nodes compacts the remaining field indices without renumbering surviving detached node IDs.
 * Consequently, a field can contain several ID runs, such as `[a, d, e]` after removing `[b, c]` from `[a, b, c, d, e]`.
 * Note that those IDs are actually represented as runs.
 * Concretely, this kind of thing can occur in the following user scenario: client A removes 5 nodes from a field,
 * and client B concurrently removes 2 of the nodes in the middle of that range. A's edit is applied first, followed by B's rebased edit.
 * Each edit allocates a new detached field for the removed nodes.
 * The detached field index after A's edit conceptually associates forest location "detachedFieldA" with minor ids [0, 1, 2, 3, 4].
 * This is represented with the range `[{ major: revisionA, minor: 0, count: 5 }]`.
 * B's edit then associates forest location "detachedFieldB" with `[{ major: B, minor: 0, count: 2 }]`, and also updates "detachedFieldA"'s mapping to
 * `[{ major: A, minor: 0, count: 1 }, { major: A, minor: 3, count: 2 }]`
 *
 * Updating retention revisions can also split records without moving nodes.
 * Range records are bookkeeping boundaries, not forest chunk boundaries.
 *
 * This index owns neither forest content nor chunk references and never edits the forest.
 * Callers coordinate forest edits with matching index updates; saved forest locations must be resolved again after edits that can move nodes.
 * This index supports ranges independently of how callers create forest fields.
 * Serialization codecs enforce their own format restrictions.
 *
 * @privateRemarks
 * This range design aims to make DetachedFieldIndex's asymptotics depend on number of edits in the collab window (counting e.g. squashed transactions of many edits as multiple edits rather than 1)
 * rather than the number of nodes edited. It is an improvement over previous implementations that required unique forest ids for each detached node.
 */
export class DetachedFieldIndex implements ReadOnlyDetachedFieldIndex {
	/**
	 * A mapping from detached node IDs to forest locations.
	 * Values are offset to the queried node's index within its forest field.
	 */
	private readonly detachedNodeToField = new RangeMap<
		Delta.DetachedNodeId,
		DetachedNodeLocation
	>(offsetDetachId, subtractDetachedNodeId, (location, offset) => ({
		root: location.root,
		index: location.index + offset,
	}));

	/**
	 * The contents of each tracked forest field, described by concatenating its immutable runs in array order.
	 * The runs are in node-index order and cover the field without gaps.
	 */
	private readonly fieldToRanges = new Map<ForestRootId, readonly DetachedFieldRange[]>();

	/**
	 * Preserves legacy major and minor insertion order without expanding grouped fields.
	 * Each field is created with one major ID, and removing nodes or changing lifetimes does not change it.
	 * A major keeps its position until its last field is removed.
	 */
	private readonly majorToFields = new Map<Major, Set<ForestRootId>>();

	/**
	 * A map from revisions to all detached spans for which the revision is the latest relevant revision.
	 * See {@link DetachedField.latestRelevantRevision}.
	 *
	 * @remarks
	 * These sets contain the same immutable record instances as {@link fieldToRanges}.
	 * {@link replaceField} removes those instances before inserting their replacements; queries return copies.
	 *
	 * undefined revisions are tolerated but any roots not associated with a revision must be disposed manually
	 */
	private readonly latestRelevantRevisionToFields = new Map<
		RevisionTag | undefined,
		Set<DetachedFieldRange>
	>();

	/**
	 * The process for loading `DetachedFieldIndex` data from a summary is split into two steps:
	 * 1. Call {@link loadData}
	 * 2. Call {@link setRevisionsForLoadedData}
	 *
	 * This flag is only set to `false` after calling `loadData` and is set back to `true` after calling `setRevisionsForLoadedData`.
	 * This helps ensure that `setRevisionsForLoadedData` is only called after `loadData` and only called once.
	 */
	private isFullyLoaded = true;

	/**
	 * @param name - A name for the index, used as a prefix for the generated field keys.
	 * @param rootIdAllocator - An ID allocator used to generate unique field keys.
	 */
	public constructor(
		private readonly name: string,
		private rootIdAllocator: IdAllocator<ForestRootId>,
	) {}

	public clone(): DetachedFieldIndex {
		const clone = new DetachedFieldIndex(
			this.name,
			idAllocatorFromMaxId(this.rootIdAllocator.getMaxId()) as IdAllocator<ForestRootId>,
		);
		clone.copyFrom(this);
		return clone;
	}

	/**
	 * Creates a restorable checkpoint of the current state of the DetachedFieldIndex.
	 */
	public createCheckpoint(): DetachedFieldIndexCheckpoint {
		const clone = this.clone();
		return () => {
			this.copyFrom(clone);
		};
	}

	private copyFrom(source: DetachedFieldIndex): void {
		this.purge();
		for (const [root, records] of source.fieldToRanges) {
			this.replaceField(
				root,
				records.map((record) => ({ ...record, id: { ...record.id } })),
			);
		}
		this.majorToFields.clear();
		for (const [major, fields] of source.majorToFields) {
			this.majorToFields.set(major, new Set(fields));
		}
		this.rootIdAllocator = idAllocatorFromMaxId(
			source.rootIdAllocator.getMaxId(),
		) as IdAllocator<ForestRootId>;
		this.isFullyLoaded = source.isFullyLoaded;
	}

	public *ranges(): Iterable<DetachedFieldRange> {
		for (const fields of this.majorToFields.values()) {
			for (const root of fields) {
				const records = this.fieldToRanges.get(root);
				assert(records !== undefined, "Unknown detached field");
				for (const record of records) {
					yield { ...record, id: { ...record.id } };
				}
			}
		}
	}

	/**
	 * Removes all entries from the index.
	 */
	public purge(): void {
		this.detachedNodeToField.clear();
		this.fieldToRanges.clear();
		this.majorToFields.clear();
		this.latestRelevantRevisionToFields.clear();
	}

	public toFieldKey(id: ForestRootId): FieldKey {
		return brand(`${this.name}-${id}`);
	}

	public tryGetLocation(id: Delta.DetachedNodeId): DetachedNodeLocation | undefined {
		return this.detachedNodeToField.getFirst(id, 1).value;
	}

	public getLocation(id: Delta.DetachedNodeId): DetachedNodeLocation {
		const location = this.tryGetLocation(id);
		assert(location !== undefined, "Unknown removed node ID");
		return location;
	}

	public getFirst(
		id: Delta.DetachedNodeId,
		count: number,
	): RangeQueryResult<DetachedNodeLocation | undefined> {
		assert(
			Number.isSafeInteger(count) && count > 0,
			"A query must contain a positive safe-integer count",
		);
		const first = this.detachedNodeToField.getFirst(id, count);
		if (first.value === undefined) {
			return { value: undefined, length: first.length };
		}
		const location = first.value;
		let length = first.length;
		while (length < count) {
			const nextId = offsetDetachId(id, length);
			const next = this.detachedNodeToField.getFirst(nextId, count - length);
			if (next.value?.root !== location.root || next.value.index !== location.index + length) {
				break;
			}
			length += next.length;
		}
		return { value: location, length };
	}

	public getFieldRanges(root: ForestRootId, range: Range): readonly DetachedNodeRange[] {
		const records = this.getCheckedField(root, range);
		const result: DetachedNodeRange[] = [];
		if (range.start === range.end) {
			return result;
		}
		let position = range.start;
		for (const record of records) {
			const recordEnd = record.index + record.count;
			if (recordEnd <= range.start) {
				continue;
			}
			if (record.index >= range.end) {
				break;
			}

			const start = Math.max(range.start, record.index);
			const end = Math.min(range.end, recordEnd);
			assert(start === position, "Forest field range contains untracked nodes");
			const id = offsetDetachId(record.id, start - record.index);
			const count = end - start;
			const previous = result[result.length - 1];
			if (
				previous !== undefined &&
				previous.id.major === id.major &&
				previous.id.minor + previous.count === id.minor
			) {
				result[result.length - 1] = {
					id: previous.id,
					count: previous.count + count,
				};
			} else {
				result.push({ id, count });
			}
			position = end;
		}
		assert(position === range.end, "Forest field range contains untracked nodes");
		return result;
	}

	public getFieldLength(root: ForestRootId): number {
		const records = this.fieldToRanges.get(root);
		assert(records !== undefined, "Unknown detached field");
		const last = records[records.length - 1];
		assert(last !== undefined, "Registered detached fields must not be empty");
		return last.index + last.count;
	}

	private getCheckedField(root: ForestRootId, range: Range): readonly DetachedFieldRange[] {
		const records = this.fieldToRanges.get(root);
		assert(records !== undefined, "Unknown detached field");
		const last = records[records.length - 1];
		assert(
			Number.isSafeInteger(range.start) &&
				Number.isSafeInteger(range.end) &&
				range.start >= 0 &&
				range.end >= range.start &&
				last !== undefined &&
				range.end <= last.index + last.count,
			"Detached field range is out of bounds",
		);
		return records;
	}

	/**
	 * Returns a snapshot of detached node ID ranges last detached or modified by the given revision.
	 * Detached node IDs remain valid when earlier ranges are removed from the same forest field.
	 */
	public getRangesLastTouchedByRevision(revision: RevisionTag): Iterable<DetachedNodeRange> {
		return Array.from(this.latestRelevantRevisionToFields.get(revision) ?? [], (record) => ({
			id: { ...record.id },
			count: record.count,
		}));
	}

	/**
	 * Registers consecutive detached node IDs under one newly allocated forest field ID.
	 * This only registers the mapping; the caller must create or transfer the corresponding forest content.
	 * @param id - The first detached node ID. The next `count - 1` IDs have the same major component and increasing minor components.
	 * None of these IDs may already be registered.
	 * @param revision - The latest relevant revision for every registered node, used for retention.
	 * This is independent of the major component of `id`.
	 * @param count - The positive safe-integer number of nodes in the new field.
	 * @returns The new field ID. Its nodes occupy indices `[0, count)` in detached node ID order.
	 * This does not append to an existing field or allocate new detached node IDs; the caller supplies those IDs.
	 */
	public createRange(
		id: Delta.DetachedNodeId,
		revision: RevisionTag | undefined = undefined,
		count: number = 1,
	): ForestRootId {
		this.assertAvailable(id, count);
		const root = this.rootIdAllocator.allocate(1);
		this.replaceField(root, [
			{
				id: makeDetachedNodeId(id.major, id.minor),
				count,
				root,
				index: 0,
				latestRelevantRevision: revision,
			},
		]);
		return root;
	}

	private assertAvailable(id: Delta.DetachedNodeId, count: number): void {
		assert(Number.isSafeInteger(count) && count > 0, "A range must contain a positive count");
		const first = this.detachedNodeToField.getFirst(id, count);
		assert(
			first.value === undefined && first.length === count,
			"Detached node ID already exists in index",
		);
	}

	/**
	 * Records the removal of nodes from a forest field, using pre-removal node indices.
	 * Surviving nodes keep their detached node IDs and lifetimes, but suffix positions shift left.
	 * This does not edit the forest.
	 * @param root - The ID of the tracked field from which nodes are removed.
	 * @param range - The half-open interval of node indices before removal, not a detached node ID range.
	 * The interval must be within the tracked field and can cross several ID runs or retention revisions.
	 * @remarks
	 * Removes the mappings and retention records for the selected nodes.
	 * Each surviving node at or after `range.end` has its index reduced by `range.end - range.start`.
	 * Removing the entire field removes its records from the index; an empty interval leaves the index unchanged.
	 */
	public deleteRange(root: ForestRootId, range: Range): void {
		this.getFieldRanges(root, range);
		const count = range.end - range.start;
		if (count === 0) {
			return;
		}
		const records = this.getCheckedField(root, range);
		const remaining: DetachedFieldRange[] = [];
		for (const record of records) {
			const end = record.index + record.count;
			if (record.index < range.start) {
				remaining.push({ ...record, count: Math.min(end, range.start) - record.index });
			}
			if (end > range.end) {
				const start = Math.max(record.index, range.end);
				remaining.push({
					...record,
					id: offsetDetachId(record.id, start - record.index),
					count: end - start,
					index: start - count,
				});
			}
		}
		this.replaceField(root, remaining);
	}

	/**
	 * Updates the latest revision that is relevant to exactly the provided detached node ID range.
	 * Fails without changing the index if any ID in the interval is unknown.
	 */
	public updateLatestRevision(
		id: Delta.DetachedNodeId,
		revision: RevisionTag | undefined,
		count: number = 1,
	): void {
		assert(Number.isSafeInteger(count) && count > 0, "A range must contain a positive count");
		const roots = new Set<ForestRootId>();
		for (const fragment of this.detachedNodeToField.getAll(id, count)) {
			assert(fragment.value !== undefined, "Detached node ID does not exist in the index");
			roots.add(fragment.value.root);
		}
		for (const root of roots) {
			const records = this.fieldToRanges.get(root);
			assert(records !== undefined, "Unknown detached field");
			const updated: DetachedFieldRange[] = [];
			for (const record of records) {
				const start = Math.max(id.minor, record.id.minor);
				const end = Math.min(id.minor + count, record.id.minor + record.count);
				if (record.id.major !== id.major || start >= end) {
					updated.push(record);
					continue;
				}
				if (record.id.minor < start) {
					updated.push({ ...record, count: start - record.id.minor });
				}
				updated.push({
					...record,
					id: offsetDetachId(record.id, start - record.id.minor),
					count: end - start,
					index: record.index + start - record.id.minor,
					latestRelevantRevision: revision,
				});
				if (end < record.id.minor + record.count) {
					updated.push({
						...record,
						id: offsetDetachId(record.id, end - record.id.minor),
						count: record.id.minor + record.count - end,
						index: record.index + end - record.id.minor,
					});
				}
			}
			this.replaceField(root, updated);
		}
	}

	/**
	 * Replaces one field's records in every index view, coalescing compatible neighbors.
	 *
	 * @remarks
	 * Work is proportional to the field's fragmentation, not its node count.
	 */
	private replaceField(root: ForestRootId, records: readonly DetachedFieldRange[]): void {
		const previousRecords = this.fieldToRanges.get(root);
		for (const previous of previousRecords ?? []) {
			this.detachedNodeToField.delete(previous.id, previous.count);
			const revisionRecords = this.latestRelevantRevisionToFields.get(
				previous.latestRelevantRevision,
			);
			assert(revisionRecords !== undefined, "Missing detached field lifetime");
			revisionRecords.delete(previous);
			if (revisionRecords.size === 0) {
				this.latestRelevantRevisionToFields.delete(previous.latestRelevantRevision);
			}
		}
		const coalesced: DetachedFieldRange[] = [];
		for (const record of records) {
			const previous = coalesced[coalesced.length - 1];
			if (
				previous !== undefined &&
				previous.id.major === record.id.major &&
				previous.id.minor + previous.count === record.id.minor &&
				previous.index + previous.count === record.index &&
				previous.latestRelevantRevision === record.latestRelevantRevision
			) {
				coalesced[coalesced.length - 1] = {
					...previous,
					count: previous.count + record.count,
				};
			} else {
				coalesced.push(record);
			}
		}
		const first = coalesced[0];
		if (first === undefined) {
			const previous = previousRecords?.[0];
			assert(previous !== undefined, "Unknown detached field");
			const fields = this.majorToFields.get(previous.id.major);
			assert(fields !== undefined, "Missing detached field major");
			fields.delete(root);
			if (fields.size === 0) {
				this.majorToFields.delete(previous.id.major);
			}
			this.fieldToRanges.delete(root);
		} else {
			if (previousRecords === undefined) {
				let fields = this.majorToFields.get(first.id.major);
				if (fields === undefined) {
					fields = new Set();
					this.majorToFields.set(first.id.major, fields);
				}
				fields.add(root);
			}
			this.fieldToRanges.set(root, coalesced);
		}
		for (const record of coalesced) {
			this.detachedNodeToField.set(record.id, record.count, {
				root: record.root,
				index: record.index,
			});
			let revisionRecords = this.latestRelevantRevisionToFields.get(
				record.latestRelevantRevision,
			);
			if (revisionRecords === undefined) {
				revisionRecords = new Set();
				this.latestRelevantRevisionToFields.set(
					record.latestRelevantRevision,
					revisionRecords,
				);
			}
			revisionRecords.add(record);
		}
	}

	/**
	 * Returns compact summary records without persisting lifetime boundaries.
	 * Singleton fields retain the legacy summary representation.
	 */
	public getSummaryData(): DetachedFieldSummaryData {
		const data: NestedMap<Major, Minor, DetachedFieldSummaryEntry> = new Map();
		for (const fields of this.majorToFields.values()) {
			for (const root of fields) {
				const records = this.fieldToRanges.get(root);
				assert(records !== undefined, "Unknown detached field");
				const first = records[0];
				assert(first !== undefined, "Detached field must not be empty");
				if (records.length === 1 && first.count === 1) {
					const { id, latestRelevantRevision } = first;
					setInNestedMap(
						data,
						id.major,
						id.minor,
						latestRelevantRevision === undefined ? { root } : { root, latestRelevantRevision },
					);
				} else {
					const last = records[records.length - 1];
					assert(last !== undefined, "Detached field must not be empty");
					let index = 0;
					for (const range of this.getFieldRanges(root, {
						start: 0,
						end: last.index + last.count,
					})) {
						setInNestedMap(data, range.id.major, range.id.minor, {
							root,
							index,
							count: range.count,
						});
						index += range.count;
					}
				}
			}
		}
		return {
			data,
			maxId: this.rootIdAllocator.getMaxId(),
		};
	}

	/**
	 * Loads the tree index from summary data, this overrides any existing data.
	 */
	public loadData(detachedFieldIndex: DetachedFieldSummaryData): void {
		const fields = getDetachedFieldSummaryRanges(detachedFieldIndex);
		this.rootIdAllocator = idAllocatorFromMaxId(
			detachedFieldIndex.maxId,
		) as IdAllocator<ForestRootId>;

		this.purge();
		this.isFullyLoaded = false;
		for (const [root, records] of fields) {
			this.replaceField(root, records);
		}
	}

	/**
	 * Sets the latest relevant revision for any roots that have an undefined latest relevant revision.
	 * This occurs when the detached field index is loaded from a summary and can only be called once after
	 * the summary has been loaded.
	 */
	public setRevisionsForLoadedData(latestRevision: RevisionTag): void {
		assert(
			!this.isFullyLoaded,
			0x9bd /* revisions should only be set once using this function after loading data from a summary */,
		);

		for (const [root, records] of this.fieldToRanges) {
			this.replaceField(
				root,
				records.map((record) => ({ ...record, latestRelevantRevision: latestRevision })),
			);
		}
		this.isFullyLoaded = true;
	}
}

/**
 * Expands range snapshots for consumers that still process one node at a time.
 * The node index is retained; nodes in the same range share a forest field ID.
 * Do not use the yielded locations after mutating the forest or index.
 * Mutation consumers must retain detached node IDs and resolve their locations again.
 */
export function* expandDetachedFieldRanges(
	ranges: Iterable<DetachedFieldRange>,
): Iterable<Omit<DetachedFieldRange, "count">> {
	for (const { id, root, index, count, latestRelevantRevision } of ranges) {
		for (let offset = 0; offset < count; offset++) {
			const entry = { id: offsetDetachId(id, offset), root, index: index + offset };
			yield latestRelevantRevision === undefined
				? entry
				: { ...entry, latestRelevantRevision };
		}
	}
}
