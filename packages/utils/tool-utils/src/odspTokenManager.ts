/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

// TODO: Caching. And mention logging.
// See here: https://github.com/Azure/azure-sdk-for-js/tree/main/sdk/identity/identity-cache-persistence#troubleshooting
import {
	InteractiveBrowserCredential,
	useIdentityPlugin,
	UsernamePasswordCredential,
	type AccessToken,
} from "@azure/identity";
import { cachePersistencePlugin } from "@azure/identity-cache-persistence";
import { unreachableCase } from "@fluidframework/core-utils/internal";
import {
	IPublicClientConfig,
	IOdspTokens,
	getOdspScope,
	pushScope,
	getAadTenant,
} from "@fluidframework/odsp-doclib-utils/internal";
import { Mutex } from "async-mutex";

import { debug } from "./debug.js";
import { IAsyncCache } from "./fluidToolRC.js";

// TODO: Look into if we want to do this for only fetch tool / examples
// (it's in theory unnecessary for e2e tests which run in single-process,
// but seems like in-memory caching is not working today)
useIdentityPlugin(cachePersistencePlugin);

/**
 * @internal
 */
export const getMicrosoftConfiguration = (): IPublicClientConfig => ({
	get clientId() {
		if (!process.env.login__microsoft__clientId) {
			throw new Error("Client ID environment variable not set: login__microsoft__clientId.");
		}
		return process.env.login__microsoft__clientId;
	},
});

/**
 * @internal
 */
export type OdspTokenConfig =
	| {
			type: "password";
			username: string;
			password: string;
	  }
	| {
			type: "browserLogin";
			navigator: (url: string) => void;
			redirectUriCallback?: (tokens: IOdspTokens) => Promise<string>;
	  };

/**
 * @internal
 */
export interface IOdspTokenManagerCacheKey {
	readonly isPush: boolean;
	readonly userOrServer: string;
}

const cacheKeyToString = (key: IOdspTokenManagerCacheKey) => {
	return `${key.userOrServer}${key.isPush ? "[Push]" : ""}`;
};

/**
 * @internal
 */
export class OdspTokenManager {
	private readonly storageCache = new Map<string, IOdspTokens>();
	private readonly pushCache = new Map<string, IOdspTokens>();
	private readonly cacheMutex = new Mutex();
	constructor(
		private readonly tokenCache?: IAsyncCache<IOdspTokenManagerCacheKey, IOdspTokens>,
	) {}

	public async updateTokensCache(key: IOdspTokenManagerCacheKey, value: IOdspTokens) {
		await this.cacheMutex.runExclusive(async () => {
			await this.updateTokensCacheWithoutLock(key, value);
		});
	}

	private async updateTokensCacheWithoutLock(key: IOdspTokenManagerCacheKey, value: IOdspTokens) {
		debug(`${cacheKeyToString(key)}: Saving tokens`);
		const memoryCache = key.isPush ? this.pushCache : this.storageCache;
		memoryCache.set(key.userOrServer, value);
		await this.tokenCache?.save(key, value);
	}

	public async getOdspTokens(
		server: string,
		clientConfig: IPublicClientConfig,
		tokenConfig: OdspTokenConfig,
		forceRefresh = false,
		forceReauth = false,
	): Promise<IOdspTokens> {
		debug("Getting odsp tokens");
		return this.getTokens(false, server, clientConfig, tokenConfig);
	}

	public async getPushTokens(
		server: string,
		clientConfig: IPublicClientConfig,
		tokenConfig: OdspTokenConfig,
		forceRefresh = false,
		forceReauth = false,
	): Promise<IOdspTokens> {
		debug("Getting push tokens");
		return this.getTokens(true, server, clientConfig, tokenConfig);
	}

	private async getTokens(
		isPush: boolean,
		server: string,
		clientConfig: IPublicClientConfig,
		tokenConfig: OdspTokenConfig,
	): Promise<IOdspTokens> {
		const makeRefreshlessProxy = (accessToken: AccessToken): IOdspTokens =>
			new Proxy(
				{
					accessToken: accessToken.token,
					refreshToken: "",
				},
				{
					get(target, prop) {
						if (prop === "refreshToken") {
							throw new Error(
								"Refresh tokens are handled transparently by @azure/identity.",
							);
						}
						return target[prop];
					},
				},
			);

		const scope = isPush ? pushScope : getOdspScope(server);
		const { type } = tokenConfig;
		switch (type) {
			case "password": {
				const tenantId = getAadTenant(server);
				const { username, password } = tokenConfig;
				const credential = new UsernamePasswordCredential(
					tenantId,
					clientConfig.clientId,
					username,
					password,
					{
						tokenCachePersistenceOptions: {
							enabled: true,
						},
					},
				);
				const accessToken = await credential.getToken(scope);
				return makeRefreshlessProxy(accessToken);
			}
			case "browserLogin": {
				const credential = new InteractiveBrowserCredential({
					clientId: clientConfig.clientId,
					tokenCachePersistenceOptions: {
						enabled: true,
					},
				});
				const accessToken = await credential.getToken(scope);
				return makeRefreshlessProxy(accessToken);
			}
			default:
				unreachableCase(type);
		}
	}
}
