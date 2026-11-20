/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { DetachedFieldIndexFormatVersion } from "../../core/index.js";
import { ForestTypeOptimized } from "../../shared-tree/index.js";
import { configuredSharedTree } from "../../treeFactory.js";

import { sequenceRangeBenchmarks } from "./sequenceRangeBenchmarkUtilities.js";

// This enables grouped producers, not a different index implementation.
// The production-default suite uses the same range-capable index with singleton producers.
sequenceRangeBenchmarks(
	"experimental grouped detaches, chunked forest",
	configuredSharedTree({
		forest: ForestTypeOptimized,
		writeVersionOverrides: new Map([
			["DetachedFieldIndex", DetachedFieldIndexFormatVersion.vRangeExperimental],
		]),
		allowPossiblyIncompatibleWriteVersionOverrides: true,
	}).getFactory(),
);
