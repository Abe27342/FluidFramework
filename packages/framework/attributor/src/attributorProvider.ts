/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
import { IDocumentMessage, ISequencedDocumentMessage, ISnapshotTree } from "@fluidframework/protocol-definitions";
import { IAudience, IDeltaManager } from "@fluidframework/container-definitions";
import { IAttributor, ISummaryTreeWithStats } from "@fluidframework/runtime-definitions";
import { SummaryTreeBuilder } from "@fluidframework/runtime-utils";
import { OpStreamAttributor } from "./attributor";
import { AttributorSerializer, chain, deltaEncoder } from "./encoders";
import { makeGzipEncoder } from "./gzipEncoder";

export interface IProvideAttributorProvider {
	IAttributorProvider: IAttributorProvider;
}

export interface IAttributorProvider extends IProvideAttributorProvider {
	initialize(
        readAndParseBlob: (id: string) => Promise<string>,
		deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>,
		audience: IAudience,
		summary?: ISnapshotTree // TODO: Plumb real serializer through correctly.
	): Promise<IAttributor & { summarize: () => ISummaryTreeWithStats; }>;
}

// TODO: Investigate resulting format.
const attributionKey = "attribution";

export class AttributorProvider implements IProvideAttributorProvider {
    public get IAttributorProvider(): IAttributorProvider {
        return this;
    }

    public async initialize(
        readAndParseBlob: (id: string) => Promise<string>,
        deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>,
		audience: IAudience,
		snapshot?: ISnapshotTree // TODO: Plumb real serializer through correctly.
    ): Promise<IAttributor & { summarize: () => ISummaryTreeWithStats; }> {
        const encoder = chain(
            new AttributorSerializer(
                (entries) => new OpStreamAttributor(deltaManager, audience, entries),
                deltaEncoder
            ),
            makeGzipEncoder(),
        );

        const attributor = snapshot !== undefined
            ? encoder.decode(await readAndParseBlob(snapshot.blobs[attributionKey]))
            : new OpStreamAttributor(deltaManager, audience);

        const result = attributor as IAttributor & { summarize: () => ISummaryTreeWithStats; };
        result.summarize = () => {
            const builder = new SummaryTreeBuilder();
            // TODO: This stringify is only here to make `readAndParseBlob` correct. Should
            // be able to plumb things better to avoid it.
            builder.addBlob(attributionKey, JSON.stringify(encoder.encode(attributor)));
            return builder.getSummaryTree();
        };
        return result;
    }
}
