/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
import { IDocumentMessage, ISequencedDocumentMessage, ISnapshotTree } from "@fluidframework/protocol-definitions";
import { IAudience, IContainerContext, IDeltaManager } from "@fluidframework/container-definitions";
import { ContainerRuntime } from "@fluidframework/container-runtime";
import type { IContainerRuntimeOptions } from "@fluidframework/container-runtime";
import { IAttributor, ISummaryTreeWithStats, ITelemetryContext, NamedFluidDataStoreRegistryEntries } from "@fluidframework/runtime-definitions";
import { addSummarizeResultToSummary, SummaryTreeBuilder } from "@fluidframework/runtime-utils";
import { OpStreamAttributor } from "./attributor";
import { AttributorSerializer, chain, deltaEncoder } from "./encoders";
import { makeGzipEncoder } from "./gzipEncoder";
import { IContainerRuntime } from "@fluidframework/container-runtime-definitions";
import { IRequest, IResponse, FluidObject } from "@fluidframework/core-interfaces";
import { IDocumentStorageService } from "@fluidframework/driver-definitions";
import { assert, bufferToString } from "@fluidframework/common-utils";

export interface IProvideAttributorProvider {
	IAttributorProvider: IAttributorProvider;
}

export interface IAttributorProvider extends IProvideAttributorProvider {
	initialize(
        storage: Pick<IDocumentStorageService, "readBlob">,
		deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>,
		audience: IAudience,
		summary?: ISnapshotTree
	): Promise<IAttributor & { summarize: () => ISummaryTreeWithStats; }>;
}

export interface IAttributorWithSummarization extends IAttributor {
    summarize: () => ISummaryTreeWithStats;
}

export class AttributorProvider implements IProvideAttributorProvider {
    public get IAttributorProvider(): IAttributorProvider {
        return this;
    }

    public async initialize(
        storage: Pick<IDocumentStorageService, "readBlob">,
        deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>,
		audience: IAudience,
		snapshot?: ISnapshotTree
    ): Promise<IAttributorWithSummarization> {
        const encoder = chain(
            new AttributorSerializer(
                (entries) => new OpStreamAttributor(deltaManager, audience, entries),
                deltaEncoder
            ),
            makeGzipEncoder(),
        );

        const attributor = snapshot !== undefined
            ? encoder.decode(bufferToString(await storage.readBlob(snapshot.blobs[attributorKey]), "utf8"))
            : new OpStreamAttributor(deltaManager, audience);

        const result = attributor as IAttributor & { summarize: () => ISummaryTreeWithStats; };
        result.summarize = () => {
            const builder = new SummaryTreeBuilder();
            builder.addBlob(attributorKey, encoder.encode(attributor));
            return builder.getSummaryTree();
        };
        return result;
    }
}

// The key for the attributor tree in summary.
// Note this is currently included twice--once as a tree path and once for the blob name.
const attributorKey = "attributor";

/**
 * Mixin class that adds await for DataObject to finish initialization before we proceed to summary.
 * @param handler - handler that returns info about blob to be added to summary.
 * Or undefined not to add anything to summary.
 * @param Base - base class, inherits from FluidDataStoreRuntime
 */
export const mixinAttributor = (
    Base: typeof ContainerRuntime = ContainerRuntime,
) => class ContainerRuntimeWithAttributor extends Base {
        public static async load(
            context: IContainerContext,
            registryEntries: NamedFluidDataStoreRegistryEntries,
            requestHandler?: ((request: IRequest, runtime: IContainerRuntime) => Promise<IResponse>) | undefined,
            runtimeOptions: IContainerRuntimeOptions | undefined = {},
            containerScope: FluidObject<unknown> | undefined = context.scope,
            existing?: boolean | undefined,
            ctor: typeof ContainerRuntime = ContainerRuntimeWithAttributor as unknown as typeof ContainerRuntime
        ): Promise<ContainerRuntime> {
            const runtime = await Base.load(
                context,
                registryEntries,
                requestHandler,
                runtimeOptions,
                containerScope,
                existing,
                ctor
            ) as ContainerRuntimeWithAttributor;

            const pendingRuntimeState = context.pendingLocalState as { baseSnapshot?: ISnapshotTree };
            const baseSnapshot: ISnapshotTree | undefined = pendingRuntimeState?.baseSnapshot ?? context.baseSnapshot;
            const attributorProvider: FluidObject<IProvideAttributorProvider> = containerScope ?? {};
            const attributor = context.audience ? await attributorProvider.IAttributorProvider?.initialize(
                runtime.storage,
                context.deltaManager,
                context.audience,
                baseSnapshot?.trees[attributorKey]
            ) : undefined;

            assert(attributor !== undefined,
                "Tried to mix in attributor to runtime without providing a way to instantiate it in scope.");
    
            runtime._attributor = attributor;
            return runtime;
        }

        private _attributor: IAttributorWithSummarization | undefined;

        public get attributor(): IAttributor {
            assert(this._attributor !== undefined, "no attributor set on ContainerRuntime");
            return this._attributor;
        }

        protected addContainerStateToSummary(
            summaryTree: ISummaryTreeWithStats,
            fullTree: boolean,
            trackState: boolean,
            telemetryContext?: ITelemetryContext,
        ) {
            super.addContainerStateToSummary(summaryTree, fullTree, trackState, telemetryContext);
            const attributorSummary = this._attributor?.summarize();
            if (attributorSummary) {
                addSummarizeResultToSummary(summaryTree, attributorKey, attributorSummary);
            }
        }
    } as unknown as typeof ContainerRuntime;
