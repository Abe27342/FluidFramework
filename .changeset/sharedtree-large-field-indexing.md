---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Improve indexed access to large SharedTree arrays

Fields with many storage chunks now cache cumulative chunk lengths.
Repeated indexed reads use binary search instead of scanning from the start of the field.
The cache is rebuilt after changes to the chunk sequence, while small fields keep the existing scan.
