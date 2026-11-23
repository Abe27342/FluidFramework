---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---

Preserve node ranges during repair-data preparation and transaction minimization

SharedTree processes requests for removed content as ranges instead of enumerating each node before checking whether its content is already available.
Transaction minimization also preserves ranges moved out of newly built subtrees instead of emitting a separate build for each moved node.
These changes reduce bookkeeping for eligible ranges without changing the resulting tree content.
