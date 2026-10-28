# Chunked Forest

Implementation of Forest using chunks.
Optimized for small memory footprint and fast loading of chunked node data.

In this context, chunks are contiguous parts of the tree which get stored together in some data format.
Multiple chunk formats will be used to optimize for different cases.
Chunks are copy-on-write, but optimized to be mutated in place when a chunk only has a single user (detected using reference counting).
This allows for efficient cloning of forests, without major performance overheads for non-cloning scenarios.

## Field indexing

Fields with at least 128 chunks lazily cache the cumulative top-level lengths of their chunks.
Cursors share this index to find a node's chunk by binary search and to read the field length without scanning.
The threshold uses chunk count because lookup cost depends on chunk boundaries, not the number of nodes within a chunk.
Smaller fields retain linear scanning without allocating an index.
Unowned arrays are not indexed because their mutation is not controlled by a sequence owner.

Operations that change chunk boundaries invalidate the index, which is fully rebuilt on its next use.
Rebuilding scans the field's k chunks; subsequent indexed lookups cost O(log k).
Alternating structural edits and reads can therefore still require O(k) work per edit/read pair.
Copy-on-write field sequences have independent indexes.
Indexes do not change the stored document format.

## Ownership and mutation

`ChunkSequence` owns a field's chunk references and length metadata.
`BasicChunk` fields and `SequenceChunk` children expose borrowed, read-only views, not mutable containers.
Constructors copy input maps, arrays, and uniform value buffers.
Child chunk references are transferred into their new owner; they are not retained automatically.

Mutable chunks use `MutableChunk` and scoped `ChunkEdit` capabilities.
An external owner can acquire an editor for an exclusive chunk.
A contained chunk must instead be edited through its owning sequence.
The sequence copies shared children before issuing a child editor.
This establishes exclusive ownership down the entire path, even when a descendant has reference count one under a shared ancestor.
Editors must be closed from child to parent, and cannot be reused after closing.
Sharing or transferring a chunk while it has an editor is rejected.

Sequence editors invalidate metadata before splices, range transformations, or edits that can change a child's top-level length.
Nested `SequenceChunk` edits invalidate the affected containing sequences.
Length invalidation stops at `BasicChunk`, whose top-level length is always one.
Cursors and ordinary sequence reads cannot observe a splice, a range transformation, or an active variable-length child edit.
Stable-length BasicChunk capabilities permit reads between mutations without invalidating ancestor length indexes.
Cursors must still be cleared or freed before content changes.

Forest visitors retain the exclusive node and field capabilities along their traversal path.
Entering and exiting a level acquires and releases only that level's capabilities, without repeating ancestor traversal or validation.
Announced visitors can read the forest between storage operations.
Cloning a forest requires releasing its visitor first; forests cloned before traversal can be edited independently.
Sharing, cloning, or transferring a chunk on a leased path remains prohibited.

Extraction returns external owning references; insertion consumes those references.
After insertion, a retained borrowed chunk object cannot acquire an external editor.
Shared sequence deaggregation creates an independent child container instead of returning the surviving wrapper's backing array.

Coalescing transfers the selected range to a synchronous transformation.
That transformation can grow an exclusive uniform chunk's value buffer in place and consume merged-away references.
The sequence adopts the result with one backing-array replacement, and rebuilds its index only on a later read.
A failed transformation does not roll back and makes the sequence unusable.

## Status

Working, but not fully optimized.
Might not provide a faster experience than the reference implementation.

Currently unconditionally splits chunks when editing.
To actually deliver on the performance goals of this design,
it will need to keep data in uniform chunks in more cases:
this mainly requires avoiding splitting them into basic chunks when editing (ex: updating a leaf number) by supporting in-place updates via replace operations (which `DeltaVisitor` currently does not expose) instead of delete and inserts which forces the data to be re-encoded as the intermediate form violates the shape requires of the uniform chunk.

SequenceChunks also aren't well optimized in the cursor, since each one traversed adds another level of wrappers on the cursor.