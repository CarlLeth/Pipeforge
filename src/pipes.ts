import { RecencyList } from "./RecencyList";

function doNothing() { }

export class PipeSignal {
    static readonly noValue = new PipeSignal();

    // TODO: Any other special signals? Examples:
    // closing: no more values to expect
    // error (any examlpes? This would be a pipe-hookup error, not an error value inside of the pipe, right?)
    // expire: clear the pipes (invalidate any remembered values)
    // pending: a new value is pending
}

export interface PipeListener<T> {
    onValue: (value: T) => void;
    //onError: (err: Error) => void;
};

function isPromise(value: any): value is PromiseLike<any> {
    return (typeof value?.then === 'function');
}

export abstract class Pipe<T> {

    static asPipe<T>(value: Pipe<T> | PromiseLike<T> | T | undefined): Pipe<T> {
        if (value === undefined) {
            return Pipe.empty<T>();
        }
        else if (value instanceof Pipe) {
            return value;
        }
        else if (isPromise(value)) {
            const state = new State<T>();
            value.then(result => state.set(result));
            return state;
        }
        else {
            return <Pipe<T>>Pipe.fixed(value);
        }
    }

    static fixed<T>(fixedValue: T): Pipe<T> {
        return new FixedPipe(fixedValue);
    }

    private static emptyPipe: Pipe<any>;
    static empty<T>() : Pipe<T> {
        if (!Pipe.emptyPipe) {
            Pipe.emptyPipe = new EmptyPipe<any>();
        }

        return Pipe.emptyPipe;
    }

    static state<T>(initialValue?: T) {
        return new State<T>(initialValue);
    }

    // Gets the value in the pipe, or returns NoValue if no value is available.
    public abstract get(): T | PipeSignal;

    // Subscribes a listener which is synchronously called when this pipe emits a ping.
    // A ping signals that the pipe may have an updated value.
    // Many pings may occur from one atomic change, so checking for the new value should be delayed.
    // This is mostly intended for 
    abstract subscribePing(onPing: () => void): () => void;

    subscribe(listener: PipeListener<T>) {

        let valuePending = false;

        const postNewValue = () => {
            valuePending = false;
            const newValue = this.get();

            if (!(newValue instanceof PipeSignal)) {
                listener.onValue(newValue);
            }
        }

        return this.subscribePing(onPing);

        function onPing() {
            if (valuePending) {
                return;
            }

            valuePending = true;
            setTimeout(postNewValue, 0);
        }
    }

    filter(predicate: (value: T) => boolean): Pipe<T> {
        return new FilterPipe<T>(this, predicate);
    }

    map<TEnd>(projection: (value: T) => TEnd): Pipe<TEnd> {
        return new MapPipe<T, TEnd>(this, projection);
    }

    remember(): Pipe<T> {
        if (this instanceof MemoryPipe) {
            return this;
        }
        else {
            return new MemoryPipe<T>(this);
        }
    }

    fold<TState>(accumulator: (state: TState, value: T) => TState, seed: TState): Pipe<TState> {
        return new AccumulatingPipe<T, TState>(this, accumulator, seed);
    }

    flatten<TInner>(this: Pipe<Pipe<TInner>>): Pipe<TInner> {
        return new FlatteningPipe(this);
    }

    flattenConcurrently<TInner>(this: Pipe<Pipe<TInner>>): Pipe<TInner> {
        return new FlatteningPipeConcurrent(this);
    }

    startWith(startingValue: T): Pipe<T> {
        return Pipe.merge(Pipe.fixed(startingValue), this);
    }

    /*
     * Returns a pipe which reproduces the signals of this pipe after (roughly) the given number of millseconds.
     */
    delay(milliseconds: number): Pipe<T> {
        return new DelayingPipe(this, milliseconds);
    }

    debounce(milliseconds: number): Pipe<Array<T>> {
        return new DebouncingPipe(this, milliseconds);
    }

    debounceLatest(milliseconds: number): Pipe<T> {
        return this.debounce(milliseconds).map(values => values[values.length - 1]);
    }

    /*
     * Returns a stream based on this one that is guaranteed to have a value at all times. Whenever this
     * stream has a value, that value is returned; otherwise, the given fallback value is returned.
     */
    fallback(getFallbackValue: () => T): Pipe<T> {
        return new FallbackPipe(this, getFallbackValue);
    }

    catch(handleError: (error: any) => void): Pipe<T>
    catch(handleError: (error: any) => T): Pipe<T>
    catch<TError>(handleError: (error: any) => TError): Pipe<T | TError> {
        return new ErrorCatchingPipe<T, TError>(this, handleError);
    }

    /*
     * Opens a subscription to this stream which performs the given action when a value is available, and then closes itself.
     * This treats the stream as if it were a promise. Note that if this stream never emits a value, the subscription is never removed.
     */
    once(doOnce: (value: T) => void) {
        let unsubscribe = doNothing;

        unsubscribe = this.subscribe({
            onValue: val => {
                unsubscribe();
                doOnce(val);
            }
        });
    }

    asPromise(): Promise<T> {
        let unsubscribe = doNothing;
        let resolve: (value: T) => void;
        let reject: (reason: any) => void;

        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });

        this.catch(err => {
            reject(err);
            unsubscribe();
        }).once(val => {
            resolve(val);
        });

        return promise;
    }

    static combine = function combine(...pipes: Array<Pipe<any>>) {
        return new CombinedPipe(pipes) as unknown;
    } as PipeCombineSignature

    static merge = function combine(...pipes: Array<Pipe<any>>) {
        return new MergedPipe(pipes) as unknown;
    } as PipeMergeSignature

    static fromPromise = function fromPromise<T>(promise: PromiseLike<T>): Pipe<T> {
        const state = new State<T>();
        promise.then(o => state.set(o));

        // TODO: Error handling?
        return state;
    }
}

interface OnOff {
    on: () => void;
    off: () => void;
}

export class SubscriptionHolder {
    private subscriberCount: number;
    private subscribers: { [subscriberIndex: number]: () => void };

    private proxyCount: number;
    private proxies: { [proxyIndex: number]: OnOff };

    constructor() {
        this.subscriberCount = 0;
        this.subscribers = {};
        this.proxyCount = 0;
        this.proxies = [];
    }

    public subscribePing(onPing: () => void): () => void {

        if (!this.any()) {
            // If this is the first subscription, switch all proxy subscriptions on.
            this.forEachProxy(proxy => proxy.on());
        }

        const subscriberIndex = this.subscriberCount;
        this.subscribers[subscriberIndex] = onPing;
        this.subscriberCount++;

        return () => {
            delete this.subscribers[subscriberIndex];
            if (!this.any()) {
                // If this is the last un-subscription, switch all proxy subscriptions off.
                this.forEachProxy(proxy => proxy.off());
            }
        }
    }

    public any() {
        for (let key in this.subscribers) {
            return true;
        }

        return false;
    }

    public sendPing() {
        for (let key in this.subscribers) {
            this.subscribers[key]();
        }
    }

    private forEachProxy(action: (proxy: OnOff) => void) {
        for (let key in this.proxies) {
            action(this.proxies[key]);
        }
    }

    // Keeps a single ping subscription open on the given pipe while any subscriptions are open
    // on this subscription holder. This allows a pipe to run interception routines at most once
    // on upstream pipes, regardless of how many pipes are downstream of them.
    // Call the returned function to disable and remove the proxy.
    public proxySubscribePing(pipe: Pipe<any>, onPing: () => void): () => void {

        let unsubscribe: () => void;
        return this.proxyLink(
            () => unsubscribe = pipe.subscribePing(onPing),
            () => unsubscribe()
        );
    }

    // Calls the "on" function when the first subscriber subscribes to this holder.
    // Calls the "off" function after the last subscriber has closed thier subscription.
    // On and off may be called more than once, but will always be called in the order [on, off, on, off, ...]
    // Call the returned function to disable and remove the proxy.
    public proxyLink(on: () => void, off: () => void): () => void {

        const proxySubscriptionSwitch = {
            on: on,
            off: off
        };

        const proxyIndex = this.proxyCount;
        this.proxies[proxyIndex] = proxySubscriptionSwitch;

        this.proxyCount++;

        if (this.any()) {
            proxySubscriptionSwitch.on();
        }

        return () => {
            if (this.any()) {
                proxySubscriptionSwitch.off();
            }
            delete this.proxies[proxyIndex];
        }
    }
}

export class State<T> extends Pipe<T> {

    static from<T>(value: T) {
        return new State<T>(value);
    }

    private subs: SubscriptionHolder;

    constructor(
        private value?: T
    ) {
        super();
        this.subs = new SubscriptionHolder();
    }

    public get(): T | PipeSignal {
        return this.value === undefined ? PipeSignal.noValue : this.value;
    }

    public set(newValue: T) {
        this.value = newValue;
        this.subs.sendPing();
    }

    subscribePing(onPing: () => void): () => void {
        if (this.value !== undefined) {
            onPing();
        }
        return this.subs.subscribePing(onPing);
    }

    public asPipe(): Pipe<T> {
        return this;
    }
}

export class FilterPipe<T> extends Pipe<T> {

    constructor(
        private parent: Pipe<T>,
        private predicate: (value: T) => boolean
    ) {
        super();
    }

    public get(): T | PipeSignal {
        const parentValue = this.parent.get();

        if (parentValue instanceof PipeSignal) {
            return parentValue;
        }
        else if (this.predicate(parentValue)) {
            return parentValue;
        }
        else {
            return PipeSignal.noValue;
        }
    }

    subscribePing(onPing: () => void): () => void {
        return this.parent.subscribePing(onPing);
    }

}

export class MapPipe<TStart, TEnd> extends Pipe<TEnd> {
    constructor(
        private parent: Pipe<TStart>,
        private projection: (value: TStart) => TEnd
    ) {
        super();
    }

    public get(): TEnd | PipeSignal {
        const parentValue = this.parent.get();

        if (parentValue instanceof PipeSignal) {
            return parentValue;
        }
        else {
            return this.projection(parentValue);
        }
    }

    subscribePing(onPing: () => void): () => void {
        return this.parent.subscribePing(onPing);
    }
}

export class MemoryPipe<T> extends Pipe<T> {

    private hasValue: boolean;
    private isDirty: boolean;
    private currentValue: T | undefined;

    constructor(
        private parent: Pipe<T>
    ) {
        super();
        this.isDirty = true;
        this.hasValue = false;
    }

    public get(): T | PipeSignal {
        if (!this.isDirty) {
            return this.currentValue === undefined ? PipeSignal.noValue : this.currentValue;
        }

        this.isDirty = false;
        const newValue = this.parent.get();

        if (newValue instanceof PipeSignal) {
            // TODO: Is this what makes the most sense here?
            // When we get a "nevermind" signal, we should probably not change our internal state.
            return this.hasValue ? this.currentValue! : PipeSignal.noValue;
        }
        else {
            this.currentValue = newValue;
            this.hasValue = true;
            return newValue;
        }
    }

    subscribePing(onPing: () => void): () => void {
        if (this.hasValue) {
            // Let the subscriber know a value is immediately available.
            onPing();
        }

        return this.parent.subscribePing(() => {
            // It's tempting to clear this.currentValue here for memory efficiency, but a ping only
            // tells us there *might* be a new value for us. It could be a "never mind" signal.
            // So we don't know for sure we can forget currentValue yet.

            this.isDirty = true;
            onPing();
        });
    }
}

export class CombinedPipe extends Pipe<Array<any>> {

    //private hasValue: Array<boolean>;
    //private lastValues: Array<any>;

    private pipes: Array<Pipe<any>>;

    constructor(
        //private pipe1: Pipe<T1>,
        //private pipe2: Pipe<T2>
        componentPipes: Array<Pipe<any>>
    ) {
        super();

        // Component pipes must have memory, because every pipe's value is needed any time
        // any pipe pings, and their values may become inaccesible (e.g. via a filter)
        this.pipes = componentPipes.map(o => o.remember());

        //this.lastValues = new Array<any>(pipes.length);
        //this.hasValue = pipes.map(o => false);
    }

    public get(): Array<any> | PipeSignal {
        const values = this.pipes.map(p => p.get());

        if (values.some(v => v instanceof PipeSignal)) {
            // TODO: If we introduce more special signals, we have to think about how they combine here.
            return PipeSignal.noValue;
        }
        else {
            return values;
        }
    }

    subscribePing(onPing: () => void): () => void {
        const allSubscriptions = this.pipes.map(p => p.subscribePing(onPing));
        return () => allSubscriptions.forEach(unsub => unsub());
    }
}

export class MergedPipe extends Pipe<any> {
    //private lastPingedPipe: Pipe<any> | undefined;
    private readonly recentPipes: RecencyList<Pipe<any>>

    constructor(pipes: Array<Pipe<any>>) {
        super();
        this.recentPipes = new RecencyList(pipes);
    }

    public get() {
        for (let pipe of this.recentPipes) {
            const value = pipe.get();
            if (!(value instanceof PipeSignal)) {
                return value;
            }
        }

        return PipeSignal.noValue;

        //if (this.lastPingedPipe) {
        //    return this.lastPingedPipe.get();
        //}
        //else {
        //    return PipeSignal.noValue;
        //}
    }

    subscribePing(onPing: () => void): () => void {
        const allSubscriptions = this.recentPipes.items.map(p => p.subscribePing(() => {
            //this.lastPingedPipe = p;
            this.recentPipes.setHead(p);
            onPing();
        }));

        return () => allSubscriptions.forEach(unsub => unsub());
    }
}

export class FixedPipe<T> extends Pipe<T> {
    constructor(
        private value: T
    ) {
        super();
    }

    public get(): T | PipeSignal {
        return this.value;
    }

    subscribePing(onPing: () => void): () => void {
        // Let the subscriber know a value is immediately available.
        onPing();
        return doNothing;
    }
}

export class EmptyPipe<T> extends Pipe<T> {
    public get(): T | PipeSignal {
        return PipeSignal.noValue;
    }

    subscribePing(onPing: () => void): () => void {
        return doNothing;
    }
}

export class FlatteningPipe<T> extends Pipe<T> {

    private lastPipe: Pipe<T> | null;
    private unsubscribe: () => void;

    private readonly parent: Pipe<Pipe<T>>;
    private readonly subs: SubscriptionHolder;

    constructor(
        parentPipeOfPipes: Pipe<Pipe<T>>
    ) {
        super();
        this.parent = parentPipeOfPipes.remember();
        this.subs = new SubscriptionHolder();
        this.unsubscribe = doNothing;
        this.lastPipe = null;

        // This doesn't need to be unsubscribed from because the subscribed object has the same lifetime as the subscribing.
        this.subs.proxySubscribePing(this.parent, () => this.subs.sendPing());
    }

    public get(): T | PipeSignal {
        const currentPipe = this.parent.get();

        if (currentPipe instanceof PipeSignal) {
            return currentPipe;
        }

        if (currentPipe !== this.lastPipe) {
            this.unsubscribe();
            this.lastPipe = currentPipe;
            this.unsubscribe = currentPipe.subscribePing(() => this.subs.sendPing());
        }

        return currentPipe.get();
    }

    subscribePing(onPing: () => void): () => void {
        return this.subs.subscribePing(onPing);
    }
}

export class FlatteningPipeConcurrent<T> extends Pipe<T> {

    private seenPipes: Set<Pipe<T>>;
    private unsubscribeFuncs: Array<() => void>;

    private readonly parent: Pipe<Pipe<T>>;
    private readonly subs: SubscriptionHolder;

    constructor(
        parentPipeOfPipes: Pipe<Pipe<T>>
    ) {
        super();
        this.parent = parentPipeOfPipes.remember();
        this.subs = new SubscriptionHolder();
        this.unsubscribeFuncs = [];
        this.seenPipes = new Set<Pipe<T>>();

        // This doesn't need to be unsubscribed from because the subscribed object has the same lifetime as the subscribing.
        this.subs.proxySubscribePing(this.parent, () => this.subs.sendPing());
    }

    public get(): T | PipeSignal {
        const currentPipe = this.parent.get();

        if (currentPipe instanceof PipeSignal) {
            return currentPipe;
        }

        if (!this.seenPipes.has(currentPipe)) {
            this.seenPipes.add(currentPipe);
            this.unsubscribeFuncs.push(currentPipe.subscribePing(() => this.subs.sendPing()));
        }

        return currentPipe.get();
    }

    subscribePing(onPing: () => void): () => void {
        return this.subs.subscribePing(onPing);
    }
}

export class DelayingPipe<T> extends Pipe<T> {

    private currentSignal: T | PipeSignal;
    private readonly subs: SubscriptionHolder;

    constructor(
        private parent: Pipe<T>,
        private delayMilliseconds: number
    ) {
        super();
        this.currentSignal = PipeSignal.noValue;
        this.subs = new SubscriptionHolder();
        this.subs.proxySubscribePing(parent, () => this.onParentPing());
    }

    private onParentPing() {
        let lastSignal: T | PipeSignal;

        // Get the value on the next frame, but wait to update it.
        setTimeout(() => {
            lastSignal = this.parent.get();
        }, 0);

        // Wait to update the current signal value and send a ping synchronously.
        // Keep as a separate timeout: this prevents the additional frame above from adding to our delay.
        setTimeout(() => {
            this.currentSignal = lastSignal;
            this.subs.sendPing();
        }, this.delayMilliseconds)
    }

    public get(): T | PipeSignal {
        return this.currentSignal;
    }

    subscribePing(onPing: () => void): () => void {
        return this.subs.subscribePing(onPing);
    }
}

export class FallbackPipe<T> extends Pipe<T> {
    constructor(
        private parent: Pipe<T>,
        private getFallbackValue: () => T
    ) {
        super();
    }

    public get(): T | PipeSignal {
        const value = this.parent.get();

        if (value instanceof PipeSignal) {
            return this.getFallbackValue();
        }
        else {
            return value;
        }
    }

    subscribePing(onPing: () => void): () => void {
        return this.parent.subscribePing(onPing);
    }
}

export class ErrorCatchingPipe<T, TError> extends Pipe<T | TError> {
    constructor(
        private parent: Pipe<T>,
        private onError: (err: any) => TError | PipeSignal | undefined | void
    ) {
        super();
    }

    public get(): T | TError | PipeSignal {
        try {
            return this.parent.get();
        } catch (err) {

            let replacement = this.onError(err);
            if (replacement === undefined) {
                replacement = PipeSignal.noValue;
            }

            return <T | TError | PipeSignal>replacement!;
        }
    }

    subscribePing(onPing: () => void): () => void {
        return this.parent.subscribePing(onPing);
    }
}

export class DebouncingPipe<T> extends Pipe<Array<T>> {

    private lastPingTime: number;
    private timeoutHandle: number;
    private bufferedValues: Array<T>;
    private subs: SubscriptionHolder;

    constructor(
        private parent: Pipe<T>,
        private debounceTimeMs: number
    ) {
        super();
        this.bufferedValues = [];
        this.lastPingTime = 0;
        this.timeoutHandle = 0;
        this.subs = new SubscriptionHolder();
        this.subs.proxySubscribePing(parent, () => this.onParentPing());
    }

    public get(): T[] | PipeSignal {
        return this.bufferedValues;
    }

    private onParentPing() {

        const delta = Date.now() - this.lastPingTime;

        // All logic below depends on getting the value of the parent stream, so we wrap it
        // behind a 0-delay timeout
        setTimeout(() => {

            const value = this.parent.get();

            if (value instanceof PipeSignal) {
                // Completely ignore non-value signals
                return;
            }

            if (this.timeoutHandle > 0) {
                clearTimeout(this.timeoutHandle);
            }

            if (delta > this.debounceTimeMs) {
                this.bufferedValues = [value];
            }
            else {
                this.bufferedValues.push(value);
            }

            this.timeoutHandle = setTimeout(() => this.subs.sendPing(), this.debounceTimeMs);

        }, 0);

    }

    subscribePing(onPing: () => void): () => void {
        return this.subs.subscribePing(onPing);
    }
}

export class AccumulatingPipe<TIn, TState> extends Pipe<TState> {

    private isDirty: boolean;
    private currentValue: TState;

    constructor(
        private parentPipe: Pipe<TIn>,
        private accumulate: (state: TState, value: TIn) => TState,
        seed: TState
    ) {
        super();
        this.currentValue = seed;
        this.isDirty = false;
    }

    public get(): TState | PipeSignal {
        if (!this.isDirty) {
            return this.currentValue;
        }

        this.isDirty = false;
        const newValue = this.parentPipe.get();

        if (newValue instanceof PipeSignal) {
            return this.currentValue;
        }
        else {
            this.currentValue = this.accumulate(this.currentValue, newValue);
            return this.currentValue;
        }
    }

    subscribePing(onPing: () => void): () => void {
        if (this.currentValue !== undefined) {
            onPing();
        }

        return this.parentPipe.subscribePing(() => {
            this.isDirty = true;
            onPing();
        });
    }
}

export interface PipeCombineSignature {
    (): Pipe<[]>;
    <T1>(x1: Pipe<T1>): Pipe<[T1]>;
    <T1, T2>(x1: Pipe<T1>, x2: Pipe<T2>): Pipe<[T1, T2]>;
    <T1, T2, T3>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>): Pipe<[T1, T2, T3]>;
    <T1, T2, T3, T4>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>): Pipe<[T1, T2, T3, T4]>;
    <T1, T2, T3, T4, T5>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>): Pipe<[T1, T2, T3, T4, T5]>;
    <T1, T2, T3, T4, T5, T6>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>): Pipe<[T1, T2, T3, T4, T5, T6]>;
    <T1, T2, T3, T4, T5, T6, T7>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>): Pipe<[T1, T2, T3, T4, T5, T6, T7]>;
    <T1, T2, T3, T4, T5, T6, T7, T8>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>): Pipe<[T1, T2, T3, T4, T5, T6, T7, T8]>;
    <T1, T2, T3, T4, T5, T6, T7, T8, T9>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>): Pipe<[T1, T2, T3, T4, T5, T6, T7, T8, T9]>;
    <T1, T2, T3, T4, T5, T6, T7, T8, T9, T10>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>): Pipe<[T1, T2, T3, T4, T5, T6, T7, T8, T9, T10]>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>): Pipe<[T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11]>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>): Pipe<[T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12]>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>, x13: Pipe<T13>): Pipe<[T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13]>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>, x13: Pipe<T13>, x14: Pipe<T14>): Pipe<[T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14]>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>, x13: Pipe<T13>, x14: Pipe<T14>, x15: Pipe<T15>): Pipe<[T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15]>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>, x13: Pipe<T13>, x14: Pipe<T14>, x15: Pipe<T15>, x16: Pipe<T16>): Pipe<[T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16]>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T17>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>, x13: Pipe<T13>, x14: Pipe<T14>, x15: Pipe<T15>, x16: Pipe<T16>, x17: Pipe<T17>): Pipe<[T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T17]>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T17, T18>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>, x13: Pipe<T13>, x14: Pipe<T14>, x15: Pipe<T15>, x16: Pipe<T16>, x17: Pipe<T17>, x18: Pipe<T18>): Pipe<[T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T17, T18]>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T17, T18, T19>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>, x13: Pipe<T13>, x14: Pipe<T14>, x15: Pipe<T15>, x16: Pipe<T16>, x17: Pipe<T17>, x18: Pipe<T18>, x19: Pipe<T19>): Pipe<[T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T17, T18, T19]>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T17, T18, T19, T20>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>, x13: Pipe<T13>, x14: Pipe<T14>, x15: Pipe<T15>, x16: Pipe<T16>, x17: Pipe<T17>, x18: Pipe<T18>, x19: Pipe<T19>, x20: Pipe<T20>): Pipe<[T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T17, T18, T19, T20]>;
    <T>(...items: Array<Pipe<T>>): Pipe<Array<T>>;
    (...items: Array<Pipe<any>>): Pipe<Array<any>>
}

export interface PipeMergeSignature {
    (): Pipe<never>;
    <T1>(x1: Pipe<T1>): Pipe<T1>;
    <T1, T2>(x1: Pipe<T1>, x2: Pipe<T2>): Pipe<T1 | T2>;
    <T1, T2, T3>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>): Pipe<T1 | T2 | T3>;
    <T1, T2, T3, T4>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>): Pipe<T1 | T2 | T3 | T4>;
    <T1, T2, T3, T4, T5>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>): Pipe<T1 | T2 | T3 | T4 | T5>;
    <T1, T2, T3, T4, T5, T6>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>): Pipe<T1 | T2 | T3 | T4 | T5 | T6>;
    <T1, T2, T3, T4, T5, T6, T7>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>): Pipe<T1 | T2 | T3 | T4 | T5 | T6 | T7>;
    <T1, T2, T3, T4, T5, T6, T7, T8>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>): Pipe<T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8>;
    <T1, T2, T3, T4, T5, T6, T7, T8, T9>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>): Pipe<T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9>;
    <T1, T2, T3, T4, T5, T6, T7, T8, T9, T10>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>): Pipe<T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>): Pipe<T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 | T11>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>): Pipe<T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 | T11 | T12>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>, x13: Pipe<T13>): Pipe<T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 | T11 | T12 | T13>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>, x13: Pipe<T13>, x14: Pipe<T14>): Pipe<T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 | T11 | T12 | T13 | T14>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>, x13: Pipe<T13>, x14: Pipe<T14>, x15: Pipe<T15>): Pipe<T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 | T11 | T12 | T13 | T14 | T15>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>, x13: Pipe<T13>, x14: Pipe<T14>, x15: Pipe<T15>, x16: Pipe<T16>): Pipe<T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 | T11 | T12 | T13 | T14 | T15 | T16>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T17>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>, x13: Pipe<T13>, x14: Pipe<T14>, x15: Pipe<T15>, x16: Pipe<T16>, x17: Pipe<T17>): Pipe<T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 | T11 | T12 | T13 | T14 | T15 | T16 | T17>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T17, T18>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>, x13: Pipe<T13>, x14: Pipe<T14>, x15: Pipe<T15>, x16: Pipe<T16>, x17: Pipe<T17>, x18: Pipe<T18>): Pipe<T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 | T11 | T12 | T13 | T14 | T15 | T16 | T17 | T18>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T17, T18, T19>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>, x13: Pipe<T13>, x14: Pipe<T14>, x15: Pipe<T15>, x16: Pipe<T16>, x17: Pipe<T17>, x18: Pipe<T18>, x19: Pipe<T19>): Pipe<T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 | T11 | T12 | T13 | T14 | T15 | T16 | T17 | T18 | T19>;
    //<T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T17, T18, T19, T20>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>, x13: Pipe<T13>, x14: Pipe<T14>, x15: Pipe<T15>, x16: Pipe<T16>, x17: Pipe<T17>, x18: Pipe<T18>, x19: Pipe<T19>, x20: Pipe<T20>): Pipe<T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 | T11 | T12 | T13 | T14 | T15 | T16 | T17 | T18 | T19 | T20>;
    <T>(...items: Array<Pipe<T>>): Pipe<T>;
    (...items: Array<Pipe<any>>): Pipe<any>
}