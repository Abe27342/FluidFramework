/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
import { assert } from "@fluidframework/common-utils";
import { IAttributor, AttributionInfo } from "@fluidframework/runtime-definitions";
import { IDocumentMessage, ISequencedDocumentMessage, MessageType } from "@fluidframework/protocol-definitions";
import { UsageError } from "@fluidframework/container-utils";
import { IDeltaManager, IAudience } from "@fluidframework/container-definitions";

export class Attributor implements IAttributor {
	protected readonly keyToInfo: Map<number, AttributionInfo>;

	constructor(
		initialEntries?: Iterable<[number, AttributionInfo]>,
	) {
		this.keyToInfo = new Map(initialEntries ?? []);
	}

	public getAttributionInfo(key: number): AttributionInfo {
		const result = this.tryGetAttributionInfo(key);
		if (!result) {
			throw new UsageError(`Requested attribution information for unstored key: ${key}.`);
		}
		return result;
	}

	public tryGetAttributionInfo(key: number): AttributionInfo | undefined {
		return this.keyToInfo.get(key);
	}

	public entries(): IterableIterator<[number, AttributionInfo]> {
		return this.keyToInfo.entries();
	}
}

export class OpStreamAttributor extends Attributor implements IAttributor {
	constructor(
		deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>,
		audience: IAudience,
		initialEntries?: Iterable<[number, AttributionInfo]>,
	) {
		super(initialEntries);
		deltaManager.on("op", (message: ISequencedDocumentMessage) => {
			if (message.type !== MessageType.Operation) {
				return;
			}
			const client = audience.getMember(message.clientId);
			// TODO: This case may be legitimate, and if so we need to figure out how to handle it.
			assert(client !== undefined, "Received message from user not in the audience");
			this.keyToInfo.set(message.sequenceNumber, { user: client.user, timestamp: message.timestamp });
		});
	}
}
