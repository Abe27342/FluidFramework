/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { ForestTypeOptimized } from "../../shared-tree/index.js";
import { configuredSharedTree } from "../../treeFactory.js";

import { sequenceRangeBenchmarks } from "./sequenceRangeBenchmarkUtilities.js";

sequenceRangeBenchmarks(
	"production defaults, chunked forest",
	configuredSharedTree({ forest: ForestTypeOptimized }).getFactory(),
);
