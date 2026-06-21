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