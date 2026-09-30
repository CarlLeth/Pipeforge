import { describe, expect, it, vi } from 'vitest';
import { Pipe } from '../src';

describe('FallbackPipe', () => {
    it('provides a value when a pipe would otherwise be empty', () => {
        const pipe = Pipe.empty<number>().fallbackValue(9);
        expect(pipe.get()).toBe(9);
    });
});

describe('DelayingPipe', () => {
    it('delays signals by a set amount of time', async () => {

        vi.useFakeTimers();

        try {
            const input = Pipe.state<number>();
            const delayed = input.delay(100);

            let result: number | undefined = undefined;

            delayed.subscribe(val => result = val);

            expect(input.get()).toBeUndefined();
            expect(delayed.get()).toBeUndefined();
            expect(result).toBeUndefined();

            // Time 0
            input.set(10);
            expect(input.get()).toBe(10);
            expect(delayed.get()).toBeUndefined();
            expect(result).toBeUndefined();

            await vi.advanceTimersByTimeAsync(60);

            // Time 60
            input.set(16);
            expect(input.get()).toBe(16);
            expect(delayed.get()).toBeUndefined();
            expect(result).toBeUndefined();

            await vi.advanceTimersByTimeAsync(60);

            // Time 120
            expect(input.get()).toBe(16);
            expect(delayed.get()).toBe(10);
            expect(result).toBe(10);

            await vi.advanceTimersByTimeAsync(100);

            // Time 220
            expect(input.get()).toBe(16);
            expect(delayed.get()).toBe(16);
            expect(result).toBe(16);
        }
        finally {
            vi.useRealTimers();
        }
    });
});

describe('AccumulatingPipe', () => {
    it('accumulates values using a state-updating function', async () => {
        vi.useFakeTimers();

        let result: number | undefined = undefined;

        const state = Pipe.state<number>();
        const sum = state.fold((state, next) => state + next, 0);

        sum.subscribe(val => result = val);
        
        expect(sum.get()).toBe(0);

        state.set(3);
        await vi.advanceTimersByTimeAsync(10);
        expect(result).toBe(3);

        state.set(5);
        await vi.advanceTimersByTimeAsync(10);
        expect(result).toBe(8);

        // An interesting case happens here.
        // The AccumulatingPipe will accept simultaneous values if they are present.
        // However, other pipes may handle simultaneous values differently.
        // Simultaneous values are a hard problem in reactive programming, and care should be taken
        // to understand behavior (and expectations) when they occur. In this exact case, the user
        // probably expects that the 11 value will be included in the accumulation, so we will
        // leave that as an expectation in this test.
        state.set(11);
        state.set(2);

        await vi.advanceTimersByTimeAsync(10);
        expect(result).toBe(21);
        expect(sum.get()).toBe(21);
    });

    it('can accumulate values before any listeners are subscribed', async () => {
        // We are trying to simplify reasoning about reactive streams by making their behavior
        // independent of whether they are subscribed to or not. Accumulating values comes with
        // common pitfalls in other reactive libraries, including different subscribers receiving different values
        // and values being dropped if nobody is subscribed. Pipeforge uses WeakRefs to maintain functionality
        // when no subscribers are active. This causes extra calls until obsolete pipes are garbage collected, but
        // significantly simplifies reasoning about the state of each pipe.

        vi.useFakeTimers();

        const state = Pipe.state<number>();
        const sum = state.fold((state, next) => state + next, 0);

        expect(sum.get()).toBe(0);

        state.set(3);
        await vi.advanceTimersByTimeAsync(10);
        expect(sum.get()).toBe(3);

        state.set(5);
        await vi.advanceTimersByTimeAsync(10);
        expect(sum.get()).toBe(8);

        state.set(11);
        state.set(2);

        await vi.advanceTimersByTimeAsync(10);
        expect(sum.get()).toBe(21);

        let result: number | undefined = undefined;
        sum.doOnce(val => result = val);

        // While it might work immediately, there is no requirement that subscriptions fire immediately.
        // Pipes are allowed a small, fixed number of cycles to propegate updates.
        await vi.advanceTimersByTimeAsync(1);
        expect(result).toBe(21);
    });
});

describe('ProducerPipe', () => {
    it('activates and disposes a producer function based on subscriptions', async () => {

        vi.useFakeTimers();

        let timeout: NodeJS.Timeout | undefined;

        let ticks = 0;
        let sum = 0;

        const producer = Pipe.producer<number>(send => {
            timeout = globalThis.setInterval(() => {
                ticks++;
                send(1);
            }, 100);

            return () => {
                globalThis.clearInterval(timeout);
            }
        });

        expect(timeout).toBeUndefined();
        expect(ticks).toBe(0);

        await vi.advanceTimersByTimeAsync(800);

        expect(timeout).toBeUndefined();
        expect(ticks).toBe(0);
        expect(sum).toBe(0);

        const unsub = producer.subscribe(val => sum += val);

        await vi.advanceTimersByTimeAsync(310);

        expect(ticks).toBe(3);
        expect(sum).toBe(3);

        unsub();

        await vi.advanceTimersByTimeAsync(500);

        expect(sum).toBe(3);
        expect(ticks).toBe(3);

    });
});

describe('State', () => {
    it('can be set and read synchronously in any order', async () => {
        vi.useFakeTimers();

        const number = Pipe.state(1);
        const letter = Pipe.state("a");

        const numlet = Pipe
            .combine(number, letter)
            .map(([n, l]) => `${n}${l}`);

        let result = "";
        numlet.subscribe(r => result = r);
        await vi.advanceTimersByTimeAsync(10);

        expect(result).toBe("1a");

        number.set(2);
        await vi.advanceTimersByTimeAsync(10);

        expect(result).toBe("2a");
        await vi.advanceTimersByTimeAsync(10);

        number.set(3);
        expect(numlet.get()).toBe("3a"); // Synchronously request the current value
        number.set(4);
        await vi.advanceTimersByTimeAsync(10);

        // "3a" should never be broadcast, although this is not currently tested for
        expect(result).toBe("4a");
    });
});

describe('FlatteningPipe', () => {
    it('emits changes when either its source pipe emits a new pipe or when the last emitted pipe emits a new value', async () => {
        vi.useFakeTimers();

        const numbers = Pipe.state(1);
        const letters = Pipe.state("a");
        const selector = Pipe.state(numbers as Pipe<number | string>);
        const flat = selector.flatten();

        let result: number | string = 0;
        flat.subscribe(v => result = v);
        expect(flat.get()).toBe(1);

        await vi.advanceTimersByTimeAsync(10);
        expect(result).toBe(1);

        selector.set(letters as Pipe<number | string>);
        await vi.advanceTimersByTimeAsync(10);
        expect(result).toBe('a');

        letters.set('b');
        numbers.set(2);
        await vi.advanceTimersByTimeAsync(10);
        expect(result).toBe('b');

        numbers.set(3);
        await vi.advanceTimersByTimeAsync(10);
        expect(result).toBe('b');

        numbers.set(4);
        selector.set(numbers as Pipe<number | string>);
        await vi.advanceTimersByTimeAsync(10);
        expect(result).toBe(4);

        numbers.set(5);
        await vi.advanceTimersByTimeAsync(10);
        expect(result).toBe(5);

        selector.set(letters as Pipe<number | string>);
        await vi.advanceTimersByTimeAsync(10);
        expect(result).toBe('b');
    });
});
