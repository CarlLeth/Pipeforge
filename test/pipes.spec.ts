import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pipe } from '../src';

beforeAll(() => {
    vi.useFakeTimers();
});

afterAll(() => {
    vi.useRealTimers();
});

describe('FallbackPipe', () => {
    it('provides a value when a pipe would otherwise be empty', () => {
        const pipe = Pipe.empty<number>().fallbackValue(9);
        expect(pipe.get()).toBe(9);
    });
});

describe('DelayingPipe', () => {
    it('delays signals by a set amount of time', async () => {

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
    });
});

describe('AccumulatingPipe', () => {
    it('accumulates values using a state-updating function', async () => {
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

describe('dropRepeats', () => {
    it('drops consecutive values that are strictly equal', async () => {
        const source = Pipe.input<number>();
        const results = traceOutputs(source.dropRepeats());
        await vi.advanceTimersByTimeAsync(10);

        source.set(1);
        await vi.advanceTimersByTimeAsync(10);
        source.set(1);
        await vi.advanceTimersByTimeAsync(10);
        source.set(2);
        await vi.advanceTimersByTimeAsync(10);
        source.set(2);
        await vi.advanceTimersByTimeAsync(10);
        source.set(1);
        await vi.advanceTimersByTimeAsync(10);

        expect(results).toEqual([1, 2, 1]);
    });

    it('keeps repeated values when another value occurs between them', async () => {
        const source = Pipe.input<number>();
        const results = traceOutputs(source.dropRepeats());
        await vi.advanceTimersByTimeAsync(10);

        source.set(3);
        await vi.advanceTimersByTimeAsync(10);
        source.set(3);
        await vi.advanceTimersByTimeAsync(10);
        source.set(4);
        await vi.advanceTimersByTimeAsync(10);
        source.set(3);
        await vi.advanceTimersByTimeAsync(10);

        expect(results).toEqual([3, 4, 3]);
    });

    it('can use a custom equality function', async () => {
        const source = Pipe.input<{ id: number; name: string }>();
        const results = traceOutputs(source.dropRepeats((a, b) => a.id === b.id));
        await vi.advanceTimersByTimeAsync(10);

        source.set({ id: 1, name: 'first' });
        await vi.advanceTimersByTimeAsync(10);
        source.set({ id: 1, name: 'updated' });
        await vi.advanceTimersByTimeAsync(10);
        source.set({ id: 2, name: 'other' });
        await vi.advanceTimersByTimeAsync(10);

        expect(results).toEqual([
            { id: 1, name: 'first' },
            { id: 2, name: 'other' }
        ]);
    });
});

describe('ProducerPipe', () => {
    it('activates and disposes a producer function based on subscriptions', async () => {

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

describe('PipeInput', () => {
    it('forwards values set directly on the input', () => {
        const input = Pipe.input<number>();

        expect(input.get()).toBeUndefined();

        input.set(3);

        expect(input.get()).toBe(3);
    });

    it('forwards values from added pipes and stops forwarding removed pipes', async () => {
        const input = Pipe.input<number>();
        const source = Pipe.state<number>();

        input.add(source);
        expect(input.has(source)).toBe(true);
        expect(input.members).toEqual([source]);

        source.set(4);
        await vi.advanceTimersByTimeAsync(10);
        expect(input.get()).toBe(4);

        input.remove(source);
        expect(input.has(source)).toBe(false);
        expect(input.members).toEqual([]);

        source.set(9);
        await vi.advanceTimersByTimeAsync(10);
        expect(input.get()).toBe(4);
    });

    it('handles well-behaved cycles', async () => {

        // Create a "safe" cycle of streams that are mutating shared state.
        // Although a State might be a better choice for this simplified example, more complex situations
        // can be handled well by treating multiple streams as each acting on shared state.

        const input = Pipe.input<number>();
        const doubleAction = Pipe.action();
        const sub1Action = Pipe.action();

        input.add(input.map(x => x * 2).gatedBy(doubleAction));
        input.add(input.map(x => x - 1).gatedBy(sub1Action));

        const results = traceOutputs(input);

        input.set(1);
        await vi.advanceTimersByTimeAsync(10);

        expect(results).toEqual([1]);

        doubleAction.call();
        await vi.advanceTimersByTimeAsync(10);
        expect(results).toEqual([1, 2]);

        doubleAction.call();
        await vi.advanceTimersByTimeAsync(10);
        expect(results).toEqual([1, 2, 4]);

        sub1Action.call();
        await vi.advanceTimersByTimeAsync(10);
        expect(results).toEqual([1, 2, 4, 3]);

        await vi.advanceTimersByTimeAsync(100);
        expect(results).toEqual([1, 2, 4, 3]);
    });
});

describe('FlatteningPipe', () => {
    it('emits changes when either its source pipe emits a new pipe or when the last emitted pipe emits a new value', async () => {
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

describe('DebouncingPipe', () => {
    it('does not emit until the debounce interval has elapsed', async () => {
        const input = Pipe.state<number>();
        const debounced = input.debounce(100);
        const results: number[] = [];

        debounced.subscribe(value => results.push(value));

        input.set(1);
        await vi.advanceTimersByTimeAsync(0);

        expect(results).toEqual([]);

        await vi.advanceTimersByTimeAsync(99);
        expect(results).toEqual([]);

        await vi.advanceTimersByTimeAsync(10);
        expect(results).toEqual([1]);
    });

    it('emits only the latest value when updates arrive during the debounce interval', async () => {
        const input = Pipe.state<number>();
        const debounced = input.debounce(100);
        const results: number[] = [];

        debounced.subscribe(value => results.push(value));

        input.set(1);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(50);

        input.set(2);
        await vi.advanceTimersByTimeAsync(0);

        await vi.advanceTimersByTimeAsync(99);
        expect(results).toEqual([]);

        await vi.advanceTimersByTimeAsync(10);
        expect(results).toEqual([2]);
    });
});

describe('ErrorCatchingPipe', () => {
    it('passes through valid values and replaces assertion failures', async () => {
        const input = Pipe.state<number>();
        const checked = input
            .assert(value => value > 0, value => `${value} must be positive`)
            .catch(error => `invalid: ${(error as Error).message}`);

        const results: Array<number | string> = [];

        checked.subscribe(value => results.push(value));

        input.set(4);
        await vi.advanceTimersByTimeAsync(10);
        expect(checked.get()).toBe(4);
        expect(results).toEqual([4]);

        input.set(-2);
        await vi.advanceTimersByTimeAsync(10);
        expect(checked.get()).toContain('invalid: -2 must be positive');
        expect(results[0]).toBe(4);
        expect(results[1]).toContain('invalid: -2 must be positive');
    });

    it('recovers after a failed value when the source becomes valid again', async () => {
        const input = Pipe.state<number>();
        const checked = input
            .assert(value => value >= 0, 'value must not be negative')
            .catch(error => `error: ${(error as Error).message}`);

        input.set(-1);
        await vi.advanceTimersByTimeAsync(10);
        expect(checked.get()).toContain('error: value must not be negative');

        input.set(6);
        await vi.advanceTimersByTimeAsync(10);
        expect(checked.get()).toBe(6);
    });

    it('suppresses an error when the handler does not return a replacement', () => {
        const input = Pipe.state<number>();
        const checked = input.assert(value => value < 10, 'value is too large').catch(() => { });

        input.set(10);
        expect(checked.get()).toBeUndefined();
    });
});

describe('GatingPipe', () => {
    it('emits the latest value only when the gating pipe signals', async () => {
        const values = Pipe.state(10);
        const gate = Pipe.action();
        const gated = values.gatedBy(gate);
        const results: number[] = [];

        gated.subscribe(value => results.push(value));
        await vi.advanceTimersByTimeAsync(10);
        expect(results).toEqual([]);

        values.set(20);
        await vi.advanceTimersByTimeAsync(10);
        expect(results).toEqual([]);

        gate.call();
        await vi.advanceTimersByTimeAsync(10);
        expect(results).toEqual([20]);

        // Emits again if the gate is called again.
        gate.call();
        await vi.advanceTimersByTimeAsync(10);
        expect(results).toEqual([20, 20]);
        expect(gated.get()).toBe(20);
    });

    it('does not emit anything before a first signal', async () => {
        const values = Pipe.state('first');
        const gate = Pipe.action();
        const gated = values.gatedBy(gate);
        const results: string[] = [];

        gated.subscribe(value => results.push(value));
        await vi.advanceTimersByTimeAsync(10);

        values.set('second');
        values.set('third');
        await vi.advanceTimersByTimeAsync(10);
        expect(results).toEqual([]);
        
        gate.call();
        await vi.advanceTimersByTimeAsync(10);
        expect(results).toEqual(['third']);
    });
});

describe('MapPipe', () => {
    it('transforms each source value', () => {
        const source = Pipe.state(3);
        const mapped = source.map(value => value * 2);

        expect(mapped.get()).toBe(6);

        source.set(5);
        expect(mapped.get()).toBe(10);
    });

    it('evaluates the projection at most once per pulled change', async () => {
        const source = Pipe.state<number>();
        const projection = vi.fn((value: number) => value * 10);
        const mapped = source.map(projection);

        source.set(1);
        await vi.advanceTimersByTimeAsync(10);
        source.set(2);
        await vi.advanceTimersByTimeAsync(10);
        source.set(3);

        // The projection function should not be called until the value is actually broadcasted or pulled somehow.
        expect(projection).not.toHaveBeenCalled();

        expect(mapped.get()).toBe(30);
        expect(projection).toHaveBeenCalledTimes(1);

        // Multiple pulls should not cause multiple calls of the projection function if the source has not changed.
        await vi.advanceTimersByTimeAsync(10);
        expect(mapped.get()).toBe(30);
        expect(projection).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(10);
        source.set(4);
        expect(mapped.get()).toBe(40);
        expect(projection).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(10);
        source.set(5);
        await vi.advanceTimersByTimeAsync(10);
        source.set(6);
        expect(mapped.get()).toBe(60);
        expect(projection).toHaveBeenCalledTimes(3);
    });
});

describe('FilterPipe', () => {
    it('emits values that satisfy the predicate and retains the last accepted value', async () => {
        const source = Pipe.state<number>();
        const filtered = source.filter(value => value % 2 === 0);
        const results: number[] = [];

        filtered.subscribe(value => results.push(value));
        await vi.advanceTimersByTimeAsync(10);

        source.set(2);
        await vi.advanceTimersByTimeAsync(10);
        expect(filtered.get()).toBe(2);
        expect(results).toEqual([2]);

        source.set(3);
        await vi.advanceTimersByTimeAsync(10);
        expect(filtered.get()).toBe(2);
        expect(results).toEqual([2]);

        source.set(4);
        await vi.advanceTimersByTimeAsync(10);
        expect(filtered.get()).toBe(4);
        expect(results).toEqual([2, 4]);
    });

    it('filters every value in a synchronous batch', () => {
        const source = Pipe.state<number>();
        const filtered = source.filter(value => value > 1);

        source.set(1);
        source.set(2);
        source.set(3);

        expect(filtered.getAll()).toEqual([2, 3]);
    });
});

describe('CombinedPipe', () => {
    it('emits the latest value from every source once all sources have values', () => {
        const number = Pipe.state(1);
        const letter = Pipe.state('a');
        const combined = Pipe.combine(number, letter);

        expect(combined.get()).toEqual([1, 'a']);

        number.set(2);
        expect(combined.get()).toEqual([2, 'a']);

        letter.set('b');
        expect(combined.get()).toEqual([2, 'b']);
    });

    it('does not emit while any source is missing a value', () => {
        const number = Pipe.state<number>();
        const letter = Pipe.state('a');
        const combined = Pipe.combine(number, letter);

        expect(combined.get()).toBeUndefined();
        expect(combined.getAll()).toEqual([]);

        number.set(2);
        expect(combined.get()).toEqual([2, 'a']);
    });

    it('combines no sources into an empty array', () => {
        expect(Pipe.combine().get()).toEqual([]);
    });

    it('does not compute or emit intermediate combinations', async () => {
        const results: any[] = [];
        let error = null;

        const subjects = Pipe.state<any>("a string");
        const funcs = Pipe.state<(val: any) => any>((str: string) => {
            try {
                return str.length;
            }
            catch (err) {
                error = err;
                return -1;
            }
        });

        const combined = Pipe
            .combine(subjects, funcs)
            .map(([val, f]) => f(val));

        combined.subscribe(value => results.push(value));

        await vi.advanceTimersByTimeAsync(10);
        expect(results).toEqual(["a string".length]);

        subjects.set(17);

        // At this point, the function str => str.length would throw an error if called.
        // However, values are not calculated until needed, either when pulled by .get() or
        // when a subscriber is subscribed AND a frame has passed.
        funcs.set((x: number) => x.toFixed(1));

        await vi.advanceTimersByTimeAsync(10);

        expect(results).toEqual(["a string".length, "17.0"]);
        expect(error).toBeNull();
    });
});

describe('MergedPipe', () => {
    it('emits the latest value from whichever source changes', async () => {
        const number = Pipe.state(1);
        const letter = Pipe.state('a');
        const merged = Pipe.merge(number, letter);

        expect(merged.getAll()).toEqual([1, 'a']);

        await vi.advanceTimersByTimeAsync(0);
        number.set(2);
        expect(merged.getAll()).toEqual([2]);

        await vi.advanceTimersByTimeAsync(0);
        letter.set('b');
        expect(merged.getAll()).toEqual(['b']);
    });

    it('emits same-batch values in source order', () => {
        const first = Pipe.state<number>();
        const second = Pipe.state<number>();
        const merged = Pipe.merge(first, second);

        second.set(3);
        first.set(1);
        second.set(4);
        first.set(2);

        expect(merged.getAll()).toEqual([1, 2, 3, 4]);
    });

    it('does not advance for no-op input pings', () => {
        const source = Pipe.state<number>();
        const empty = source.filter(() => false);
        const merged = Pipe.merge(empty);

        expect(merged.getVersion()).toBe(-1);

        source.set(1);
        merged.get();

        expect(merged.getAll()).toEqual([]);
        expect(merged.getVersion()).toBe(-1);
    });
});

// Returns an array that is updated with all outputs from the stream
// This is only for testing and not meant to be a good example of how to use this library.
function traceOutputs<T>(pipe: Pipe<T>) {
    const outputs: Array<T> = [];
    pipe.subscribe(val => outputs.push(val));
    return outputs;
}
