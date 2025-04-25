/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

// import { unreachableCase } from "@fluidframework/core-utils/internal";

import { AcceptanceCondition, BaseFuzzTestState, Weights, AsyncWeights } from "./types2.js";

/**
 * Returns a generator which produces a categorial distribution with the provided weights.
 * (see https://en.wikipedia.org/wiki/Categorical_distribution)
 *
 * @param weights - Object defining either values or generators to yield from with corresponding likelihoods.
 * Each potential category can also provide an acceptance function, which restricts whether that category can be
 * chosen for a particular input state.
 *
 * @example
 *
 * ```typescript
 * const modifyGenerator = ({ random, list }) => {
 *     return { type: "modify", index: random.integer(0, list.length - 1) };
 * };
 * // Produces an infinite stochastic generator which:
 * // - If both "insert" and "delete" are valid, generates "insert" with 3 times the likelihood as it generates
 * //  "delete"
 * // - Produces values from `modifyGenerator` with the same likelihood it produces an "insert"
 * // - Only allows production of a "delete" operation if the underlying state list is non-empty
 * const generator = createWeightedGenerator([
 *     [{ type: "insert" }, 3],
 *     [modifyGenerator, 3]
 *     [{ type: "delete" }, 1, (state) => state.list.length > 0]
 * ]);
 * ```
 *
 * @internal
 */
export function* createWeightedGenerator<T, TState extends BaseFuzzTestState>(
	state: TState,
	weights: Weights<T, TState>,
): Generator<T> {
	const cumulativeSums: [T | Generator<T>, number, AcceptanceCondition<TState>?][] = [];
	let totalWeight = 0;
	for (const [tOrGenerator, weight, shouldAccept] of weights) {
		const cumulativeWeight = totalWeight + weight;
		if (weight > 0) {
			cumulativeSums.push([tOrGenerator, cumulativeWeight, shouldAccept]);
		}
		totalWeight = cumulativeWeight;
	}
	const { random } = state;
	const sample = () => {
		const weightSelected = random.real(0, totalWeight);

		let opIndex = 0;
		while (cumulativeSums[opIndex][1] < weightSelected) {
			opIndex++;
		}

		return opIndex;
	};

	if (totalWeight === 0) {
		throw new Error("createWeightedGenerator must have some positive weight");
	}

	while (true) {
		let index: number;
		let shouldAccept: AcceptanceCondition<TState> | undefined;
		do {
			index = sample();
			shouldAccept = cumulativeSums[index][2];
		} while (!(shouldAccept?.(state) ?? true));

		const [tOrGenerator] = cumulativeSums[index];
		if (isGeneratorObject(tOrGenerator)) {
			const { value, done } = (tOrGenerator as Generator<T>).next();
			if (done) {
				break;
			}
			yield value;
		} else {
			yield tOrGenerator as T;
		}
	}
}

/**
 * Higher-order generator operator which creates a new generator producing the first `n` elements of `generator`.
 * @internal
 */
export function* take<T, TState>(n: number, generator: Generator<T>): Generator<T> {
	for (let i = 0; i < n; i++) {
		const { value, done } = generator.next();
		if (done) {
			break;
		}
		yield value;
	}
}

/**
 * @returns a deterministic generator that always returns the items of `contents` in order.
 * @internal
 */
export function* generatorFromArray<T>(contents: T[]): Generator<T> {
	for (const item of contents) {
		yield item;
	}
}

/**
 * Higher-order generator operator which exhausts each input generator sequentially before moving on to the next.
 * @internal
 */
export function* chain<T>(...generators: Generator<T>[]): Generator<T> {
	for (const generator of generators) {
		yield* generator;
	}
}

/**
 * Higher-order generator operator which exhausts each input generator sequentially before moving on to the next.
 * @internal
 */
export function* chainGenerators<T>(generators: Generator<Generator<T>, void>): Generator<T> {
	while (true) {
		const { value: currentGenerator, done } = generators.next();
		if (done) {
			return;
		}
		yield* currentGenerator;
	}
}

/**
 * Controls exit behavior for {@link interleave}.
 * @internal
 */
export enum ExitBehavior {
	OnBothExhausted,
	OnEitherExhausted,
}

/**
 * Interleaves outputs from `generator1` and `generator2`.
 * By default outputs are taken one at a time, but can be controlled with `numOps1` and `numOps2`.
 * This is useful in stochastic tests for producing a certain operation (e.g. "validate" or "synchronize") at a
 * defined interval.
 *
 * Exhausts both input generators before terminating by default. If {@link ExitBehavior.OnEitherExhausted} is
 * provided, instead exits as soon as the next element it would produce is `done`.
 *
 * @example
 *
 * ```typescript
 * // Assume gen1 produces 1, 2, 3, ... and gen2 produces "a", "b", "c", ...
 * interleave(gen1, gen2) // 1, a, 2, b, 3, c, ...
 * interleave(gen1, gen2, 2) // 1, 2, a, 3, 4, b, 5, 6, c, ...
 * interleave(take(2, gen1), gen2, 1, 1, ExitBehavior.OnEitherExhausted) // 1, a, 2, b
 * interleave(gen1, take(2, gen2), 1, 1, ExitBehavior.OnEitherExhausted) // 1, a, 2, b, 3
 * interleave(gen1, take(3, gen2), 2, 3) // 1, 2, a, b, c, 3, 4
 * interleave(gen1, take(2, gen2), 2, 3) // 1, 2, a, b
 * ```
 * @internal
 */
export function* interleave<T>(
	generator1: Generator<T>,
	generator2: Generator<T>,
	numOps1 = 1,
	numOps2 = 1,
	exitBehavior = ExitBehavior.OnBothExhausted,
): Generator<T> {
	// the implementation here should be easily extendable to more than 2 generators if we have a use case for it.
	const exhausted = [false, false];
	const shouldExit = () =>
		exitBehavior === ExitBehavior.OnEitherExhausted
			? exhausted.some((e) => e)
			: exhausted.every((e) => e);

	while (!shouldExit()) {
		for (let i = 0; i < numOps1; i++) {
			const { value, done } = generator1.next();
			exhausted[0] = done ?? false;
			if (done) {
				break;
			}
			yield value;
		}

		if (shouldExit()) {
			break;
		}

		for (let i = 0; i < numOps2; i++) {
			const { value, done } = generator2.next();
			exhausted[1] = done ?? false;
			if (done) {
				break;
			}
			yield value;
		}
	}
}

/**
 * Creates a generator for an infinite stream of `t`s.
 * @param t - Output value to repeatedly generate.
 * @internal
 */
export function* repeat<T>(t: T): Generator<T> {
	while (true) {
		yield t;
	}
}

/**
 * Returns a generator which produces a categorical distribution with the provided weights.
 * (see https://en.wikipedia.org/wiki/Categorical_distribution)
 *
 * @param weights - Object defining either values or async generators to yield from with corresponding likelihoods.
 * Each potential category can also provide an acceptance function, which restricts whether that category can be
 * chosen for a particular input state.
 *
 * @example
 *
 * ```typescript
 * const modifyGenerator = async ({ random, list }) => {
 *     return { type: "modify", index: random.integer(0, list.length - 1) };
 * };
 * // Produces an infinite generator which:
 * // - If both "insert" and "delete" are valid, generates "insert" with 3 times the likelihood as it generates
 * //  "delete"
 * // - Produces values from `modifyGenerator` with the same likelihood it produces an "insert"
 * // - Only allows production of a "delete" operation if the underlying state list is non-empty
 * const generator = createWeightedAsyncGenerator([
 *     [{ type: "insert" }, 3],
 *     [modifyGenerator, 3]
 *     [{ type: "delete" }, 1, (state) => state.list.length > 0]
 * ]);
 * ```
 * @internal
 */
/**
 * Returns a generator which produces a categorial distribution with the provided weights.
 * (see https://en.wikipedia.org/wiki/Categorical_distribution)
 *
 * @param weights - Object defining either values or generators to yield from with corresponding likelihoods.
 * Each potential category can also provide an acceptance function, which restricts whether that category can be
 * chosen for a particular input state.
 *
 * @example
 *
 * ```typescript
 * const modifyGenerator = ({ random, list }) => {
 *     return { type: "modify", index: random.integer(0, list.length - 1) };
 * };
 * // Produces an infinite stochastic generator which:
 * // - If both "insert" and "delete" are valid, generates "insert" with 3 times the likelihood as it generates
 * //  "delete"
 * // - Produces values from `modifyGenerator` with the same likelihood it produces an "insert"
 * // - Only allows production of a "delete" operation if the underlying state list is non-empty
 * const generator = createWeightedGenerator([
 *     [{ type: "insert" }, 3],
 *     [modifyGenerator, 3]
 *     [{ type: "delete" }, 1, (state) => state.list.length > 0]
 * ]);
 * ```
 *
 * @internal
 */
export async function* createWeightedAsyncGenerator<T, TState extends BaseFuzzTestState>(
	state: TState,
	weights: AsyncWeights<T, TState>,
): AsyncGenerator<T> {
	const cumulativeSums: [T | AsyncGenerator<T>, number, AcceptanceCondition<TState>?][] = [];
	let totalWeight = 0;
	for (const [tOrGenerator, weight, shouldAccept] of weights) {
		const cumulativeWeight = totalWeight + weight;
		if (weight > 0) {
			cumulativeSums.push([tOrGenerator, cumulativeWeight, shouldAccept]);
		}
		totalWeight = cumulativeWeight;
	}
	const { random } = state;
	const sample = () => {
		const weightSelected = random.real(0, totalWeight);

		let opIndex = 0;
		while (cumulativeSums[opIndex][1] < weightSelected) {
			opIndex++;
		}

		return opIndex;
	};

	if (totalWeight === 0) {
		throw new Error("createWeightedGenerator must have some positive weight");
	}

	while (true) {
		let index: number;
		let shouldAccept: AcceptanceCondition<TState> | undefined;
		do {
			index = sample();
			shouldAccept = cumulativeSums[index][2];
		} while (!(shouldAccept?.(state) ?? true));

		const [tOrGenerator] = cumulativeSums[index];
		if (isAsyncGeneratorObject(tOrGenerator)) {
			const { value, done } = await (tOrGenerator as unknown as AsyncGenerator<T>).next();
			if (done) {
				break;
			}
			yield value;
		} else {
			yield tOrGenerator as T;
		}
	}
}
/**
 * Higher-order generator operator which creates a new generator producing the first `n` elements of `generator`.
 * @internal
 */
export async function* takeAsync<T>(
	n: number,
	generator: AsyncGenerator<T>,
): AsyncGenerator<T> {
	for (let i = 0; i < n; i++) {
		const { value, done } = await generator.next();
		if (done) {
			break;
		}
		yield value;
	}
}

/**
 * @returns a deterministic generator that always returns the items of `contents` in order.
 * @internal
 */
export async function* asyncGeneratorFromArray<T>(contents: T[]): AsyncGenerator<T> {
	for (const item of contents) {
		yield item;
	}
}

/**
 * Higher-order generator operator which exhausts each input generator sequentially before moving on to the next.
 * @internal
 */
export async function* chainAsync<T>(...generators: AsyncGenerator<T>[]): AsyncGenerator<T> {
	for (const generator of generators) {
		yield* generator;
	}
}

/**
 * Higher-order generator operator which exhausts each input generator sequentially before moving on to the next.
 * @internal
 */
export async function* chainAsyncIterables<T>(
	generators: AsyncGenerator<AsyncGenerator<T>, void>,
): AsyncGenerator<T> {
	while (true) {
		const { value: currentGenerator, done } = await generators.next();
		if (done) {
			return;
		}
		yield* currentGenerator;
	}
}

/**
 * AsyncGenerator variant of {@link interleave}.
 * @internal
 */
export async function* interleaveAsync<T>(
	generator1: AsyncGenerator<T>,
	generator2: AsyncGenerator<T>,
	numOps1 = 1,
	numOps2 = 1,
	exitBehavior = ExitBehavior.OnBothExhausted,
): AsyncGenerator<T> {
	// the implementation here should be easily extendable to more than 2 generators if we have a use case for it.
	const exhausted = [false, false];
	const shouldExit = () =>
		exitBehavior === ExitBehavior.OnEitherExhausted
			? exhausted.some((e) => e)
			: exhausted.every((e) => e);

	while (!shouldExit()) {
		for (let i = 0; i < numOps1; i++) {
			const { value, done } = await generator1.next();
			exhausted[0] = done ?? false;
			if (done) {
				break;
			}
			yield value;
		}

		if (shouldExit()) {
			break;
		}

		for (let i = 0; i < numOps2; i++) {
			const { value, done } = await generator2.next();
			exhausted[1] = done ?? false;
			if (done) {
				break;
			}
			yield value;
		}
	}
}

/**
 * Creates a generator for an infinite stream of `t`s.
 * @param t - Output value to repeatedly generate.
 * @internal
 */
export async function* repeatAsync<T>(t: T): AsyncGenerator<T> {
	while (true) {
		yield t;
	}
}

const generatorFunctionPrototype = Object.getPrototypeOf(function* () {});
function isGeneratorObject(value: unknown): value is Generator<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		value.constructor === generatorFunctionPrototype
	);
}

const asyncGeneratorFunctionPrototype = Object.getPrototypeOf(async function* () {});
function isAsyncGeneratorObject(value: unknown): value is AsyncGenerator<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		value.constructor === asyncGeneratorFunctionPrototype
	);
}
