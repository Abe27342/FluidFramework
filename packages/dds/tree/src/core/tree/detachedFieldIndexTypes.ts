/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { Brand, ReadonlyNestedMap } from "../../util/index.js";
import type { RevisionTag } from "../rebase/index.js";

import type * as Delta from "./delta.js";
import type { NodeIndex } from "./pathTree.js";

export type Major = RevisionTag | undefined;
export type Minor = number;

export interface DetachedFieldSummaryData {
	readonly data: ReadonlyNestedMap<Major, Minor, DetachedFieldSummaryEntry>;
	readonly maxId: ForestRootId;
}

/**
 * A summary record keyed by its starting detached node ID.
 * Omitted range metadata denotes a legacy singleton forest field.
 * Latest relevant revisions are not persisted by the codecs.
 */
export type DetachedFieldSummaryEntry = DetachedField &
	(
		| { readonly index?: never; readonly count?: never }
		| { readonly index: NodeIndex; readonly count: number }
	);

/**
 * ID used to create a detached field key for a removed subtree.
 *
 * TODO: Move to Forest once forests can support multiple roots.
 */
export type ForestRootId = Brand<number, "tree.ForestRootId">;

/**
 * The forest field ID and node index of a detached node.
 * @remarks
 * This is a snapshot, not a stable handle.
 * Retain detached node IDs and resolve them again after mutations that can move nodes within or between fields.
 */
export interface DetachedNodeLocation {
	readonly root: ForestRootId;
	readonly index: NodeIndex;
}

/**
 * A nonempty run of consecutive detached node IDs with the same major ID.
 */
export interface DetachedNodeRange {
	readonly id: Delta.DetachedNodeId;
	readonly count: number;
}

/**
 * A run of consecutive detached node IDs at consecutive positions in one field.
 */
export interface DetachedFieldRange extends DetachedNodeLocation, DetachedNodeRange {
	/**
	 * The latest relevant revision for every node in this run.
	 * See {@link DetachedField.latestRelevantRevision}.
	 */
	readonly latestRelevantRevision?: RevisionTag;
}

/**
 * A field that is detached from the main document tree.
 */
export interface DetachedField {
	/**
	 * The atomic ID that the `DetachedFieldIndex` uses to uniquely identify the first (and only) root in the field.
	 * This ID is scoped to the specific `DetachedFieldIndex` from which this object was retrieved.
	 *
	 * This legacy representation only supports a single root per field.
	 * Use {@link DetachedFieldRange} for fields that contain multiple roots.
	 */
	readonly root: ForestRootId;
	/**
	 * The revision that last detached the root node or modified its contents (including its descendant's contents).
	 *
	 * Once this revision is trimmed from the ancestry on which a `TreeCheckout` is moored,
	 * the contents of the associated subtree (and the very fact of its past existence) can be erased.
	 *
	 * @remarks
	 * undefined revisions are tolerated but any roots not associated with a revision must be disposed manually.
	 * Current usages of undefined are:
	 * - When loading a {@link DetachedFieldIndex} from a snapshot,
	 * until {@link DetachedFieldIndex.setRevisionsForLoadedData} is called.
	 * - When applying a rollback changeset.
	 * This only occurs within the context of {@link DefaultResubmitMachine} whose repair data is GC-ed when its
	 * `DetachedField` and `Forest` are GC-ed.
	 */
	readonly latestRelevantRevision?: RevisionTag;
}
