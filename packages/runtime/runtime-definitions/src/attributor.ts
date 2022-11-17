/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IUser } from "@fluidframework/protocol-definitions";

export interface AttributionInfo {
	user: IUser;
	timestamp: number;
}

export interface IAttributor {
	getAttributionInfo(key: number): AttributionInfo;

	tryGetAttributionInfo(key: number): AttributionInfo | undefined;

	entries(): IterableIterator<[number, AttributionInfo]>;

	/** TODO: GC */
}