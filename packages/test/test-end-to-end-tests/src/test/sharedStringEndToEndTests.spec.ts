/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { Container } from "@fluidframework/container-loader";
import { ISegment, Marker, ReferenceType, reservedMarkerIdKey } from "@fluidframework/merge-tree";
import { requestFluidObject } from "@fluidframework/runtime-utils";
import { SharedString } from "@fluidframework/sequence";
import {
    ITestObjectProvider,
    ITestContainerConfig,
    DataObjectFactoryType,
    ChannelFactoryRegistry,
    ITestFluidObject,
} from "@fluidframework/test-utils";
import { describeNoCompat } from "@fluidframework/test-version-utils";
import { AttributorProvider } from "@fluid-internal/attributor";

const stringId = "sharedStringKey";
const registry: ChannelFactoryRegistry = [[stringId, SharedString.getFactory()]];
const testContainerConfig: ITestContainerConfig = {
    fluidDataObjectType: DataObjectFactoryType.Test,
    registry,
    loaderProps: {
        scope: { IAttributorProvider: new AttributorProvider() },
        options: {
            trackAttribution: true
        }
    }
};

describeNoCompat("SharedString", (getTestObjectProvider) => {
    let provider: ITestObjectProvider;
    beforeEach(() => {
        provider = getTestObjectProvider();
    });

    let sharedString1: SharedString;
    let sharedString2: SharedString;
    let dataObject1: ITestFluidObject;
    let container1: Container;
    let container2: Container;

    beforeEach(async () => {
        container1 = await provider.makeTestContainer(testContainerConfig) as Container;
        dataObject1 = await requestFluidObject<ITestFluidObject>(container1, "default");
        sharedString1 = await dataObject1.getSharedObject<SharedString>(stringId);

        container2 = await provider.loadTestContainer(testContainerConfig) as Container;
        const dataObject2 = await requestFluidObject<ITestFluidObject>(container2, "default");
        sharedString2 = await dataObject2.getSharedObject<SharedString>(stringId);
    });

    it("can sync SharedString across multiple containers", async () => {
        const text = "syncSharedString";
        sharedString1.insertText(0, text);
        assert.equal(sharedString1.getText(), text, "The retrieved text should match the inserted text.");

        // Wait for the ops to to be submitted and processed across the containers.
        await provider.ensureSynchronized();

        assert.equal(sharedString2.getText(), text, "The inserted text should have synced across the containers");
    });

    it("can sync SharedString to a newly loaded container", async () => {
        const text = "syncToNewContainer";
        sharedString1.insertText(0, text);
        assert.equal(sharedString1.getText(), text, "The retrieved text should match the inserted text.");

        // Wait for the ops to to be submitted and processed across the containers.
        await provider.ensureSynchronized();

        // Create a initialize a new container with the same id.
        const newContainer = await provider.loadTestContainer(testContainerConfig) as Container;
        const newComponent = await requestFluidObject<ITestFluidObject>(newContainer, "default");
        const newSharedString = await newComponent.getSharedObject<SharedString>(stringId);
        assert.equal(
            newSharedString.getText(), text, "The new container should receive the inserted text on creation");
    });

    it("marker passes on attachment directly and transitively to any referenced DDS", async () => {
        // Insert a simple marker.
        sharedString1.insertMarker(
            0,
            ReferenceType.Simple,
            {
                [reservedMarkerIdKey]: "markerId",
            },
        );
        const detachedString1 = SharedString.create(dataObject1.runtime, "detachedString1");
        detachedString1.insertMarker(
            0,
            ReferenceType.Simple,
            {
                [reservedMarkerIdKey]: "markerId",
            },
        );
        const detachedString2 = SharedString.create(dataObject1.runtime, "detachedString2");

        // When an unattached DDS refers to another unattached DDS, both remain unattached
        const simpleMarker = detachedString1.getMarkerFromId("markerId") as Marker;
        const prop = { color: detachedString2.handle };
        detachedString1.annotateMarker(simpleMarker, prop);

        assert.equal(detachedString1.isAttached(), false, "detachedString1 should not be attached");
        assert.equal(detachedString2.isAttached(), false, "detachedString2 should not be attached");
        assert.equal(sharedString1.isAttached(), true, "sharedString1 should be attached");

        // When referring SharedString becomes attached, the referred SharedString becomes attached
        // and the attachment transitively passes to a second referred SharedString
        const simpleMarker2 = sharedString1.getMarkerFromId("markerId") as Marker;
        const prop2 = { color: detachedString1.handle };
        sharedString1.annotateMarker(simpleMarker2, prop2);

        assert.equal(detachedString1.isAttached(), true, "detachedString1 should be attached");
        assert.equal(detachedString2.isAttached(), true, "detachedString2 should be attached");
        assert.equal(sharedString1.isAttached(), true, "sharedString1 should be attached");
    });

    it("stores attribution information", async () => {
        sharedString1.insertText(0, " world");
        sharedString2.insertText(0, "hello");
        await provider.ensureSynchronized();

        const getSegments = (str: SharedString): ISegment[] => {
            const segs: ISegment[] = [];
            str.walkSegments((seg) => {
                segs.push(seg);
                return true;
            });
            return segs;
        };

        const segments1 = getSegments(sharedString1);
        assert.equal(segments1.length, 2);
        const { attributor } = dataObject1.context.containerRuntime;
        assert(attributor !== undefined);
        const attributionInfos = segments1.map(
            (seg) => {
                const key = seg.attribution?.getAtOffset(0);
                assert(key !== undefined);
                return attributor.getAttributionInfo(key as number);
            }
        );

        assert.deepEqual(attributionInfos.map(({ timestamp }) => typeof timestamp), ["number", "number"]);
        assert.deepEqual(
            attributionInfos.map(({ user }) => user.id),
            [container1, container2].map((container) => {
                const { clientId } = container;
                if (clientId) {
                    return dataObject1.runtime.getAudience().getMember(clientId)?.user.id;
                }
            })
        );
    });
});
