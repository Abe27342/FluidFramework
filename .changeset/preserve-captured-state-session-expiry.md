---
"@fluidframework/container-definitions": minor
"@fluidframework/container-loader": minor
"@fluidframework/container-runtime": minor
"__section": fix
---
Preserve session expiry when capturing and reusing container state

State captured with `serializeAttached({ includePendingLocalState: false })` or `captureFullContainerState` now preserves the garbage-collection session lifetime.
Loading and recapturing state does not renew this lifetime.
Expired state is rejected on load, preventing offline edits from introducing references to content that the live document has already deleted.
This fix does not add expiry metadata to previously captured state.

Reusable serialization requires the optional `IRuntime.getReusableState` hook.
`ContainerRuntime` implements this hook without capturing pending edits, compressor session identity, or pending blob uploads.
Other runtimes must implement it to support reusable serialization; otherwise, `serializeAttached({ includePendingLocalState: false })` throws a `UsageError`.
Driver-only capture supplies its expiry baseline through `IContainerContext.sessionExpiryTimerStarted`, which the runtime must honor on load.
