/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { createIdCompressor } from "@fluidframework/id-compressor/internal";
import {
	MockContainerRuntimeFactory,
	MockFluidDataStoreRuntime,
	MockStorage,
} from "@fluidframework/test-runtime-utils/internal";
import { SchemaFactory, SharedTree } from "../../../index.js";

describe("SharedTree schema compatibility", () => {
	describe("can interpret data at rest", () => {
		it("after an optional field is added to an object type", async () => {
			const oldBuilder = new SchemaFactory("compatibility");
			class PersonOld extends oldBuilder.object("Person", {
				name: oldBuilder.string,
				age: oldBuilder.number,
			}) {}

			const newBuilder = new SchemaFactory("compatibility");
			class PersonNew extends newBuilder.object("Person", {
				name: newBuilder.string,
				age: newBuilder.number,
				phoneNumber: newBuilder.optional(newBuilder.string),
				aage: newBuilder.optional(newBuilder.number),
			}) {}

			const containerRuntimeFactory = new MockContainerRuntimeFactory();
			const dataRuntime1 = new MockFluidDataStoreRuntime({
				idCompressor: createIdCompressor(),
			});
			const containerRuntime1 = containerRuntimeFactory.createContainerRuntime(dataRuntime1);
			const stFactory = SharedTree.getFactory();
			const treeOld = stFactory.create(dataRuntime1, "tree1");
			const view1 = treeOld.schematize({
				schema: PersonOld,
				initialTree: () => new PersonOld({ name: "Alice", age: 30 }),
			});
			treeOld.connect({
				deltaConnection: dataRuntime1.createDeltaConnection(),
				objectStorage: new MockStorage(),
			});

			assert.equal((view1 as any).error, undefined);
			assert.equal(view1.root.age, 30);
			assert.equal(view1.root.name, "Alice");

			// Load second tree using summary taken from the first one.
			const dataRuntime2 = new MockFluidDataStoreRuntime({
				idCompressor: createIdCompressor(),
			});
			const containerRuntime2 = containerRuntimeFactory.createContainerRuntime(dataRuntime2);
			const { summary } = await treeOld.summarize(true);
			const treeNew = await stFactory.load(
				dataRuntime2,
				"tree2",
				{
					deltaConnection: dataRuntime2.createDeltaConnection(),
					objectStorage: MockStorage.createFromSummary(summary),
				},
				stFactory.attributes,
			);
			const view2 = treeNew.schematize({
				schema: PersonNew,
				initialTree: () =>
					new PersonNew({
						name: "Bob",
						age: 40,
						phoneNumber: "123-456-7890",
						aage: undefined,
					}),
			});

			assert.equal(view2.compatibility.canView, false);
			assert.equal(view2.compatibility.canUpgrade, true);
			view2.upgradeSchema();

			containerRuntimeFactory.processAllMessages();
			assert.equal(view2.compatibility.isExactMatch, true);
			const { root: root2 } = view2;
			assert.equal(root2.name, "Alice");
			assert.equal(root2.age, 30);
			assert.equal(root2.phoneNumber, undefined);

			// TODO: Do I want to test some sort of further collab here, depending on spec?
			assert.equal(view1.compatibility.canView, true);
			assert.equal(view1.compatibility.canUpgrade, false);
		});

		it("after a new object type is added to a union type", async () => {
			const oldBuilder = new SchemaFactory("compatibility");
			class Point extends oldBuilder.object("Point", {
				x: oldBuilder.number,
				y: oldBuilder.number,
			}) {}
			class Canvas extends oldBuilder.object("Canvas", {
				items: oldBuilder.array("canvas items", Point),
			}) {}
			const newBuilder = new SchemaFactory("compatibility");
			class Point2 extends newBuilder.object("Point", {
				x: newBuilder.number,
				y: newBuilder.number,
			}) {}
			class Circle extends newBuilder.object("Circle", {
				center: Point2,
				radius: newBuilder.number,
			}) {}
			class Canvas2 extends newBuilder.object("Canvas", {
				items: newBuilder.array("canvas items", [Point2, Circle]),
			}) {}

			const containerRuntimeFactory = new MockContainerRuntimeFactory();
			const dataRuntime1 = new MockFluidDataStoreRuntime({
				idCompressor: createIdCompressor(),
			});
			const containerRuntime1 = containerRuntimeFactory.createContainerRuntime(dataRuntime1);
			const stFactory = SharedTree.getFactory();
			const treeOld = stFactory.create(dataRuntime1, "tree1");
			const view1 = treeOld.schematize({
				schema: Canvas,
				initialTree: () => new Canvas({ items: [new Point({ x: 5, y: 10 })] }),
			});
			treeOld.connect({
				deltaConnection: dataRuntime1.createDeltaConnection(),
				objectStorage: new MockStorage(),
			});
			assert.equal((view1 as any).error, undefined);
			assert.equal(view1.root.items.length, 1);
			assert.equal(view1.root.items[0].x, 5);
			assert.equal(view1.root.items[0].y, 10);
			// Load second tree using summary taken from the first one.
			const dataRuntime2 = new MockFluidDataStoreRuntime({
				idCompressor: createIdCompressor(),
			});
			const containerRuntime2 = containerRuntimeFactory.createContainerRuntime(dataRuntime2);
			const { summary } = await treeOld.summarize(true);
			const treeNew = await stFactory.load(
				dataRuntime2,
				"tree2",
				{
					deltaConnection: dataRuntime2.createDeltaConnection(),
					objectStorage: MockStorage.createFromSummary(summary),
				},
				stFactory.attributes,
			);
			const view2 = treeNew.schematize({
				schema: Canvas2,
				initialTree: () =>
					new Canvas2({
						items: [new Circle({ center: new Point({ x: 0, y: 0 }), radius: 20 })],
					}),
			});
			assert.equal(view2.compatibility.canView, false);
			assert.equal(view2.compatibility.canUpgrade, true);
			view2.upgradeSchema();
			containerRuntimeFactory.processAllMessages();
			assert.equal(view2.compatibility.isExactMatch, true);
			const { root: root2 } = view2;
			assert(root2.items[0] instanceof Point2);
			assert.equal(root2.items[0].x, 5);
			assert.equal(root2.items[0].y, 10);

			// TODO: Do I want to test some sort of further collab here, depending on spec?
			assert.equal(view1.compatibility.canView, true);
			assert.equal(view1.compatibility.canUpgrade, false);
		});

		it("after a required field is made optional", async () => {
			const oldBuilder = new SchemaFactory("compatibility");
			class PersonOld extends oldBuilder.object("Person", {
				name: oldBuilder.string,
				age: oldBuilder.number,
			}) {}

			const newBuilder = new SchemaFactory("compatibility");
			class PersonNew extends newBuilder.object("Person", {
				name: newBuilder.string,
				age: newBuilder.optional(newBuilder.number),
			}) {}

			const containerRuntimeFactory = new MockContainerRuntimeFactory();
			const dataRuntime1 = new MockFluidDataStoreRuntime({
				idCompressor: createIdCompressor(),
			});
			const containerRuntime1 = containerRuntimeFactory.createContainerRuntime(dataRuntime1);
			const stFactory = SharedTree.getFactory();
			const treeOld = stFactory.create(dataRuntime1, "tree1");
			const view1 = treeOld.schematize({
				schema: PersonOld,
				initialTree: () => new PersonOld({ name: "Alice", age: 30 }),
			});
			treeOld.connect({
				deltaConnection: dataRuntime1.createDeltaConnection(),
				objectStorage: new MockStorage(),
			});

			assert.equal((view1 as any).error, undefined);
			assert.equal(view1.root.age, 30);
			assert.equal(view1.root.name, "Alice");

			// Load second tree using summary taken from the first one.
			const dataRuntime2 = new MockFluidDataStoreRuntime({
				idCompressor: createIdCompressor(),
			});
			const containerRuntime2 = containerRuntimeFactory.createContainerRuntime(dataRuntime2);
			const { summary } = await treeOld.summarize(true);
			const treeNew = await stFactory.load(
				dataRuntime2,
				"tree2",
				{
					deltaConnection: dataRuntime2.createDeltaConnection(),
					objectStorage: MockStorage.createFromSummary(summary),
				},
				stFactory.attributes,
			);
			const view2 = treeNew.schematize({
				schema: PersonNew,
				initialTree: () =>
					new PersonNew({
						name: "Bob",
						age: undefined,
					}),
			});

			assert.equal(view2.compatibility.canView, false);
			assert.equal(view2.compatibility.canUpgrade, true);
			view2.upgradeSchema();

			containerRuntimeFactory.processAllMessages();
			assert.equal(view2.compatibility.isExactMatch, true);
			const { root: root2 } = view2;
			assert.equal(root2.name, "Alice");
			assert.equal(root2.age, 30);

			// TODO: Do I want to test some sort of further collab here, depending on spec?
			assert.equal(view1.compatibility.canView, true);
			assert.equal(view1.compatibility.canUpgrade, false);
		});
	});
});
