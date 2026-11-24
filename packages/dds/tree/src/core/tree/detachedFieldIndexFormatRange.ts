/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { StableId } from "@fluidframework/id-compressor";
import type { Static } from "typebox";
import * as Type from "typebox/type";

import { brandedIntegerType } from "../../util/index.js";
import type { EncodedRevisionTag } from "../rebase/index.js";

import { DetachedFieldIndexFormatVersion } from "./detachedFieldIndexFormatCommon.js";
import { StableOrFinalRevisionTag } from "./detachedFieldIndexFormatV2.js";
import type { ForestRootId } from "./detachedFieldIndexTypes.js";

/**
 * Starting detached node ID, forest field ID, starting node index, and node count.
 * The containing tuple supplies the revision for the detached node IDs.
 */
const FieldRange = Type.Tuple([
	Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
	brandedIntegerType<ForestRootId>({ minimum: -1, maximum: Number.MAX_SAFE_INTEGER }),
	Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
]);

/**
 * Compact detached field ranges. Lifetimes are assigned by the checkout after loading.
 */
export const FormatRange = Type.Object(
	{
		version: Type.Literal(DetachedFieldIndexFormatVersion.vRangeExperimental),
		data: Type.Array(
			Type.Tuple([
				Type.Unsafe<EncodedRevisionTag | StableId>(StableOrFinalRevisionTag),
				Type.Array(FieldRange),
			]),
		),
		maxId: brandedIntegerType<ForestRootId>({
			minimum: -1,
			maximum: Number.MAX_SAFE_INTEGER,
		}),
	},
	{ additionalProperties: false },
);

export type FormatRange = Static<typeof FormatRange>;
