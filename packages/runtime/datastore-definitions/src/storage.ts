/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/**
 * Represents the attributes of a channel/DDS.
 */
export interface IChannelAttributes extends IConfigurableChannelAttributes {
	/**
	 * Type name of the DDS for factory look up with ISharedObjectRegistry
	 */
	readonly type: string;

	/**
	 * The package version of the code of the DDS, for debug only
	 */
	readonly packageVersion?: string;
}

/**
 * Subset of a channel/DDS's attributes which conceptually parameterize that DDS, impacting its behavior.
 *
 * DDS channel factories will commonly extend this interface with additional parameters. Like `IChannelAttributes`,
 * all content must be JSON-serializable.
 *
 * TODO: Document status of this, design doc for desired end-state.
 * @example - TODO.
 */
export interface IConfigurableChannelAttributes {
	/**
	 * Format version of the snapshot
	 * Currently, only use to display a debug message if the version is incompatible
	 */
	readonly snapshotFormatVersion: string;
}
