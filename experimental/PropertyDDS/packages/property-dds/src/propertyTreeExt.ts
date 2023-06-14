/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IChannelFactory, IFluidDataStoreRuntime } from "@fluidframework/datastore-definitions";
import { SharedPropertyTree } from "./propertyTree";
import { DeflatedPropertyTreeFactory, LZ4PropertyTreeFactory } from "./propertyTreeExtFactories";

/**
 * This class is the extension of SharedPropertyTree which compresses
 * the deltas and summaries communicated to the server by Deflate.
 */
export class DeflatedPropertyTree extends SharedPropertyTree {
	public static create(runtime: IFluidDataStoreRuntime, id?: string, queryString?: string) {
		// TODO: This looks like a place that actually wants parameterized DDS creation:
		// if so, attributes should not be static
		return runtime.createChannel(
			id,
			DeflatedPropertyTreeFactory.Type,
			DeflatedPropertyTreeFactory.Attributes,
		) as DeflatedPropertyTree;
	}

	public static getFactory(): IChannelFactory {
		return new DeflatedPropertyTreeFactory();
	}
}

export class LZ4PropertyTree extends SharedPropertyTree {
	public static create(runtime: IFluidDataStoreRuntime, id?: string, queryString?: string) {
		// TODO: This looks like a place that actually wants parameterized DDS creation:
		// if so, attributes should not be static
		return runtime.createChannel(
			id,
			LZ4PropertyTreeFactory.Type,
			LZ4PropertyTreeFactory.Attributes,
		) as LZ4PropertyTree;
	}

	public static getFactory(): IChannelFactory {
		return new LZ4PropertyTreeFactory();
	}
}
