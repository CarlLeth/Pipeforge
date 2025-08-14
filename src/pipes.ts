function doNothing() { }

type PipeInnerType<T extends Pipe<any>> = Parameters<Parameters<T['map']>[0]>[0];

type LabeledPipes = { [index: string]: Pipe<any> };
type CombinedLabeled<TTemplate extends LabeledPipes> = {
    [k in keyof TTemplate]: PipeInnerType<TTemplate[k]>
};

type MergedLabeled<TTemplate extends LabeledPipes> = {
    [k in keyof TTemplate]?: PipeInnerType<TTemplate[k]>
};

type ShutdownFunction = () => void;

function isPromise(value: any): value is PromiseLike<any> {
    return (typeof value?.then === 'function');
}

export abstract class Pipe<T> {

    public static debug = {
        isTracing: false,
        lastCycle: null as Pipe<any>
    };

    constructor() {
        if (Pipe.debug.isTracing) {
            this['trace'] = new Error();
        }
    }

    // -- Static recordkeeping --

    private static livePipes = new Set<Pipe<any>>();

    protected static globalTick = 0;
    private static globalTickUpdated = false;

    protected static updateGlobalTick() {
        if (!Pipe.globalTickUpdated) {
            Pipe.globalTick++;
            Pipe.globalTickUpdated = true;
            setTimeout(() => Pipe.globalTickUpdated = false);
        }
    }

    // -- Primary public methods --

    get(): T | undefined {
        this.updateIfNecessary();

        if (this.values.length === 0) {
            return undefined;
        }

        return this.values[this.values.length - 1];
    }

    getAll(): Array<T> {
        this.updateIfNecessary();
        return this.values;
    }

    getTick() {
        this.updateIfNecessary();
        return this.valueTick;
    }

    subscribe(onValue: (value: T) => void) {
        this.subscribers.add(onValue);

        // Force this pipe to stay alive
        Pipe.livePipes.add(this);

        const unsubscribe = () => {
            this.subscribers.delete(onValue);
            if (this.subscribers.size === 0) {
                // Allow this pipe to be garbage collected
                Pipe.livePipes.delete(this);
            }
        };

        // Queue up a call to onValue if we have (or might soon have) a value.
        if (this.values.length > 0 || this.isDirty) {
            setTimeout(() => {
                const nextValue = this.get();
                if (nextValue !== undefined) {
                    onValue(nextValue);
                }
            })
        }

        return unsubscribe;
    }

    // -- Private/protected inner workings --

    // Indicates whether the Pipe needs to check for new values
    protected isDirty: boolean = true;

    private isUpdating: boolean = false;

    private values: Array<T> = [];
    private valueTick = -1;
    private lastBroadcastTick = -1;

    private weakListeners = new Set<WeakRef<Pipe<any>>>();

    private subscribers = new Set<(value: T) => void>();

    private updateIfNecessary() {
        if (this.isUpdating) {
            Pipe.debug.lastCycle = this;
            throw new Error("Cycle detected", { cause: this });
        }

        if (this.isDirty) {
            this.isUpdating = true;
            const nextValueTick = this.updateTick();

            // A changed tick indicates new values
            if (nextValueTick != null && nextValueTick !== this.valueTick) {
                const nextValues = this.updateValues();

                if (nextValues !== null) {
                    this.values = nextValues;
                    this.valueTick = nextValueTick;
                }
            }

            this.isUpdating = false;
            this.isDirty = false;
        }
    }
    /**
     * Recalculates and returns the latest tick value for this pipe, or null if the tick value should not change.
     */
    protected updateTick(): number | null {
        return null;
    }

    /**
     * Recalculates and returns the latest values for this pipe, or null if the values should not change.
     * If this is called, it is guaranteed that updateTick was previously called for the same cycle.
     */
    protected updateValues(): Array<T> | null {
        return null;
    }

    private isOn = false;

    private firstListenerAdded = () => { }
    protected onFirstListenerAdded(handle: () => void) {
        const inner = this.firstListenerAdded;
        this.firstListenerAdded = () => {
            inner();
            handle();
        };
    }

    private checkForFirstListener() {
        if (!this.isOn && (this.weakListeners.size + this.subscribers.size) >= 0) {
            this.isOn = true;
            this.firstListenerAdded();
        }
    }

    private lastListenerRemoved = () => { }
    protected onLastListenerRemoved(handle: () => void) {
        const inner = this.lastListenerRemoved;
        this.lastListenerRemoved = () => {
            inner();
            handle();
        };
    }

    private checkForLastListener() {
        if (this.isOn && (this.weakListeners.size + this.subscribers.size) === 0) {
            this.isOn = false;
            this.lastListenerRemoved();
        }
    }

    protected pingListeners() {
        this.weakListeners.forEach(ref => {
            const pipe = ref.deref();
            if (pipe == undefined) {
                this.weakListeners.delete(ref);
                this.checkForLastListener();
            }
            else {
                pipe.onPing();
            }
        });

        if (this.subscribers.size > 0) {
            setTimeout(() => this.broadcastValue(), 0);
        }
    }

    protected onPing() {
        if (!this.isDirty) {
            this.isDirty = true;
            this.pingListeners();
        }
    }

    protected broadcastValue() {
        if (this.getTick() <= this.lastBroadcastTick) {
            return;
        }

        this.lastBroadcastTick = this.getTick();

        const nextValue = this.get();
        if (nextValue !== undefined) {
            this.subscribers.forEach(send => send(nextValue));
        }
    }

    protected listenTo(...sourcePipes: Array<Pipe<any>>) {
        Pipe.updateGlobalTick();

        const ref = new WeakRef(this);
        sourcePipes.forEach(source => {
            source.weakListeners.add(ref);
            source.checkForFirstListener();

            if (source.isDirty || source.values.length > 0) {
                // If we're just starting to listen to a pipe that has a new value (or may have one soon), then we also may have a new value soon.
                this.onPing();
            }
        });
    }

    protected unlisten(pipeToStopListening: Pipe<any>) {
        for (const ref of pipeToStopListening.weakListeners) {
            const pipe = ref.deref();

            if (pipe === this) {
                pipeToStopListening.weakListeners.delete(ref);
                pipeToStopListening.checkForLastListener();
                return;
            }
        }
    }

    protected postValues(values: Array<T>) {
        if (values.length > 0) {
            Pipe.updateGlobalTick();
            this.values = values;
            this.isDirty = false;
            this.valueTick = Pipe.globalTick;
            this.pingListeners();
        }
    }

    protected initValues(values: Array<T>) {
        if (values.length > 0) {
            this.values = values;
            this.valueTick = 0;
            this.pingListeners();
        }
    }

    protected postSingleValue(value: T) {
        Pipe.updateGlobalTick();

        if (this.valueTick === Pipe.globalTick) {
            // Accumulate values that are posted in the same cycle.
            this.values = [...this.values, value];
        }
        else {
            // This is the first value posted this cycle.
            this.values = [value];
        }

        this.isDirty = false;
        this.valueTick = Pipe.globalTick;
        this.pingListeners();
    }

    // -- Factories and transformations --

    static asPipe<T>(value: Pipe<T> | PromiseLike<T> | T | undefined): Pipe<T> {
        if (value === undefined) {
            return Pipe.empty<T>();
        }
        else if (value instanceof Pipe) {
            return value;
        }
        else if (isPromise(value)) {
            const state = State.new<T>();
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

    // TODO: Is the allocation savings of have one pipe worth the possibility of thousands of subscribers to the same pipe?
    // This may degrade the performance of "unlisten"
    private static emptyPipe: Pipe<any>;
    static empty<T>(): Pipe<T> {
        if (!Pipe.emptyPipe) {
            Pipe.emptyPipe = new EmptyPipe<any>();
        }

        return Pipe.emptyPipe;
    }

    static state<T>(initialValue?: T) {
        return State.new(initialValue);
    }

    static isPipe<T>(value: Pipe<T> | unknown): value is Pipe<T> {
        return value instanceof Pipe;
    }

    filter(predicate: (value: T) => boolean): Pipe<T> {
        return new FilterPipe<T>(this, predicate);
    }

    map<TEnd>(projection: (value: T) => (TEnd | undefined)): Pipe<TEnd> {
        return new MapPipe<T, TEnd>(this, projection);
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

    /*
     * Returns a pipe which reproduces the signals of this pipe after (roughly) the given number of millseconds.
     */
    delay(milliseconds: number): Pipe<T> {
        return new DelayingPipe(this, milliseconds);
    }

    debounce(milliseconds: number): Pipe<T> {
        return new DebouncingPipe(this, milliseconds);
    }

    /*
     * Returns a stream based on this one that is guaranteed to have a value at all times. Whenever this
     * stream has a value, that value is returned; otherwise, the given fallback value is returned.
     */
    fallback(getFallbackValue: () => T): Pipe<T> {
        return new FallbackPipe(this, getFallbackValue);
    }

    fallbackValue(fixedFallbackValue: T): Pipe<T> {
        return new FallbackPipe(this, () => fixedFallbackValue);
    }

    fallbackPipe(fallback: Pipe<T>): Pipe<T> {
        if (!(fallback instanceof Pipe)) {
            throw new Error(`Attempted to set a fallbackPipe of ${fallback}`);
        }

        return new FallbackInnerPipe(this, fallback);
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
    doOnce(action: (value: T) => void) {
        let unsubscribe = doNothing;

        // TODO: Unsubscribe on error
        unsubscribe = this.subscribe(val => {
            unsubscribe();
            action(val);
        });
    }

    dropRepeats(equals?: (a: T, b: T) => boolean): Pipe<T> {
        if (!equals) {
            equals = (a, b) => a === b;
        }

        // TODO: Make this a first-class Pipe implementation
        return this
            .fold((last, next) => (last.val !== undefined && equals!(last.val, next)) ? { keep: false, val: next } : { keep: true, val: next }, { keep: true, val: undefined })
            .filter(o => o.keep)
            .map(o => o.val) as Pipe<T>;
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
        }).doOnce(val => {
            resolve(val);
        });

        return promise;
    }

    /**
     * Returns a new pipe that checks the given condition against each value and throws an error if the value does not meet the condition.
     * @param assertion
     * @param failureMessage
     */
    assert(assertion: (value: T) => boolean, failureMessage: string | ((failedValue: T) => string)): Pipe<T> {
        return new ConditionAssertingPipe(this, assertion, failureMessage);
    }


    /**
     * Returns a new pipe whose value is the latest value sent by this pipe, modified by any updates that
     * were sent by the given pipe since the last new value. New values from this pipe will overwrite any updates
     * that have occurred.
     * @param updates
     */
    withUpdates(updates: Pipe<(currentState: T) => T>): Pipe<T> {
        return new UpdatingPipe(this, updates);
    }

    withTransitions<TTransition>(transitions: Pipe<TTransition>, applyTransition: (value: T, transition: TTransition) => T): Pipe<T> {
        const updates = transitions.map(update => (value: T) => applyTransition(value, update));
        return this.withUpdates(updates);
    }

    compose<TResult>(transform: (thisPipe: Pipe<T>) => TResult) {
        return transform(this);
    }

    sampleCombine<T2>(addonPipe: Pipe<T2>): Pipe<[T, T2]> {
        // TODO: This probably deserves a dedicated Pipe implementation.
        return Pipe
            .mergeLabeled({ sample: this, addon: addonPipe })
            .fold((state, next) => {
                if ('sample' in next) {
                    return {
                        emit: true,
                        data: <[T, T2]>[next.sample, state.data[1]]
                    };
                }
                else {
                    return {
                        emit: false,
                        data: <[T, T2]>[state.data[0], next.addon]
                    }
                }
            }, { emit: false, data: <[T | undefined, T2 | undefined]>[undefined, undefined] })
            .filter(o => o.emit && o.data[0] !== undefined && o.data[1] !== undefined)
            .map(o => o.data as [T, T2]);
    }

    /**
     * Returns a pipe that copies values from this pipe whenever the given pipe sends any ping.
     * The returned pipe will only send signals when gatingPipe does, and will contain whatever value
     * this pipe had the last time the gated pipe sent a signal.
     */
    gatedBy(gatingPipe: Pipe<any>): Pipe<T> {
        return new GatingPipe(this, gatingPipe);
    }

    static combine = function combine(...pipes: Array<Pipe<any>>) {
        return new CombinedPipe(pipes) as unknown;
    } as PipeCombineSignature

    static combineLabeled<TTemplate extends LabeledPipes>(templateObj: TTemplate): Pipe<CombinedLabeled<TTemplate>> {
        return new CombinedPipeLabeled(templateObj);
    }

    static merge = function merge(...pipes: Array<Pipe<any>>) {
        return new MergedPipe(pipes) as unknown;
    } as PipeMergeSignature

    static mergeLabeled<TTemplate extends LabeledPipes>(templateObj: TTemplate): Pipe<MergedLabeled<TTemplate>> {
        const pipesWithLabels = Object.keys(templateObj).map(key => templateObj[key].map(val => ({ [key]: val })))
        return Pipe.merge(...pipesWithLabels) as Pipe<MergedLabeled<TTemplate>>;
    }

    static fromPromise<T>(promise: PromiseLike<T>): Pipe<T> {
        const state = State.new<() => T>();

        promise.then(o => state.set(() => o));

        if ('catch' in promise) {
            (<Promise<T>>promise).catch(err => state.set(() => {
                throw err;
            }));
        }

        return state
            .map(f => f());
    }

    static producer<T>(activate: (send: (value: T) => void) => ShutdownFunction): Pipe<T> {
        return new ProducerPipe(activate);
    }

    static action<T = null>(): Action<T> {
        return new Action<T>();
    }

    static input<T>(initialValue?: T) {
        return new PipeInput<T>(initialValue);
    }

    static periodic(periodMs: number): Pipe<null> {
        return Pipe.producer(send => {
            const handle = window.setInterval(() => send(null), periodMs);
            return () => window.clearInterval(handle);
        });
    }

    static error(createError: () => (Error | string)): Pipe<any> {
        return Pipe.producer(send => {
            const err = createError();

            if (typeof (err) === 'string') {
                throw new Error(err);
            }
            else {
                throw err;
            }
        });
    }

    asPipe(): Pipe<T> {
        return this;
    }
}

export class FilterPipe<T> extends Pipe<T> {

    constructor(
        public readonly source: Pipe<T>,
        public readonly predicate: (value: T) => boolean
    ) {
        super();
        this.listenTo(source);
    }

    protected updateTick(): number | null {
        const filteredValues = this.source.getAll().filter(val => this.predicate(val));
        if (filteredValues.length > 0) {
            return this.source.getTick();
        }
        else {
            return null;
        }
    }

    protected updateValues(): Array<T> {
        return this.source.getAll().filter(val => this.predicate(val));
    }
}

export class MapPipe<TSource, TEnd> extends Pipe<TEnd> {

    constructor(
        public readonly source: Pipe<TSource>,
        public readonly projection: (value: TSource) => TEnd | undefined
    ) {
        super();
        this.listenTo(source);
    }

    protected updateTick(): number | null {
        return this.source.getTick();
    }

    protected updateValues(): Array<TEnd> {
        return <Array<TEnd>>this.source.getAll().map(val => this.projection(val)).filter(val => val !== undefined);
    }
}

export class CombinedPipe extends Pipe<Array<any>> {

    private latestTicks: Array<number>;

    constructor(
        public readonly pipes: Array<Pipe<any>>
    ) {
        super();
        this.latestTicks = pipes.map(_ => -1);
        this.listenTo(...pipes);

        if (pipes.length === 0) {
            // A combination of 0 pipes is the same a Pipe.fixed([]).
            this.postSingleValue([]);
        }
    }

    protected updateTick(): number | null {

        if (!this.pipes.some((pipe, i) => pipe.getTick() > this.latestTicks[i])) {
            // No pipes have updated values
            return null;
        }

        const latestValues = this.pipes.map(pipe => pipe.get());
        if (latestValues.some(val => val === undefined)) {
            // If any pipes have undefined values, do not emit anything.
            return null;
        }

        this.latestTicks = this.pipes.map(pipe => pipe.getTick());

        return Pipe.globalTick;
    }

    protected updateValues(): Array<Array<any>> {
        const latestValues = this.pipes.map(pipe => pipe.get());

        if (latestValues.some(val => val === undefined)) {
            return [];
        }
        else {
            return [latestValues];
        }
    }
}

export class CombinedPipeLabeled<TTemplate extends LabeledPipes> extends Pipe<CombinedLabeled<TTemplate>> {

    private latestTicks: Record<string, number>;

    constructor(
        public readonly template: TTemplate
    ) {
        super();
        this.latestTicks = {};

        let anyKeys = false;
        for (const key in template) {
            anyKeys = true;
            this.latestTicks[key] = -1;
        }

        this.listenTo(...Object.values(template));

        if (!anyKeys) {
            // A labeled combination of 0 pipes is the same as Pipe.fixed({}).
            this.postSingleValue(<CombinedLabeled<TTemplate>>{});
        }
    }

    protected updateTick(): number | null {
        if (!Object.keys(this.template).some(key => this.template[key].getTick() > this.latestTicks[key])) {
            // No pipes have updated values
            return null;
        }

        for (const key in this.template) {
            if (this.template[key].get() === undefined) {
                // If any pipes have undefined values, do not emit anything.
                return null;
            }
        }

        for (const key in this.template) {
            this.latestTicks[key] = this.template[key].getTick();
        }

        //return Object.values(this.template).reduce((max, pipe) => Math.max(max, pipe.getTick()), -1);
        return Pipe.globalTick;
    }

    protected updateValues(): Array<CombinedLabeled<TTemplate>> | null {
        const result: { [key: string]: any } = {};

        for (const key in this.template) {
            const childValue = this.template[key].get();

            if (childValue === undefined) {
                return null;
            }

            result[key] = childValue;
        }

        return [<CombinedLabeled<TTemplate>>result];
    }
}

export class MergedPipe extends Pipe<any> {

    private lastTicks: Array<number>;

    constructor(
        public readonly pipes: Array<Pipe<any>>
    ) {
        super();
        this.listenTo(...pipes);
        this.lastTicks = pipes.map(_ => -1);
    }

    protected updateTick(): number | null {
        return this.pipes.reduce((max, pipe) => Math.max(max, pipe.getTick()), -1);
    }

    protected updateValues(): Array<any> {
        const changedPipes = this.pipes.filter((pipe, i) => pipe.getTick() > this.lastTicks[i]);
        this.lastTicks = this.pipes.map(pipe => pipe.getTick());
        return changedPipes.map(pipe => pipe.getAll()).flat();
    }
}

export class FixedPipe<T> extends Pipe<T> {

    constructor(
        value: T
    ) {
        super();
        this.postValues([value]);
    }
}

export class EmptyPipe<T> extends Pipe<T> {
    constructor() {
        super();
    }

    protected updateTick(): number | null {
        return -1;
    }

    protected updateValues(): Array<T> {
        return [];
    }
}

export class DelayingPipe<T> extends Pipe<T> {

    private lastSourceTick = -1;

    constructor(
        public readonly source: Pipe<T>,
        public readonly delayMilliseconds: number
    ) {
        super();
        this.listenTo(source);
    }

    protected onPing() {

        let lastValues: Array<T>;

        // Wait until the "ping" phase is complete before caching the value
        setTimeout(() => {
            if (this.source.getTick() > this.lastSourceTick) {
                this.lastSourceTick = this.source.getTick();
                lastValues = this.source.getAll();
            }
        }, 0);

        setTimeout(() => {
            if (lastValues != null) {
                this.postValues(lastValues);
            }
        }, this.delayMilliseconds);
    }
}

export class FallbackPipe<T> extends Pipe<T> {

    constructor(
        public readonly source: Pipe<T>,
        public readonly getFallbackValue: () => T
    ) {
        super();
        this.listenTo(source);
    }

    protected updateTick(): number | null {
        return Math.max(0, this.source.getTick());
    }

    protected updateValues(): Array<T> {
        const sourceVals = this.source.getAll();
        return sourceVals.length === 0 ? [this.getFallbackValue()] : sourceVals;
    }
}

export class FallbackInnerPipe<T> extends Pipe<T> {

    constructor(
        public readonly source: Pipe<T>,
        public readonly fallBackTo: Pipe<T>
    ) {
        super();
        this.listenTo(source, fallBackTo);
    }

    protected updateTick(): number | null {
        const sourceVals = this.source.getAll();
        return sourceVals.length === 0 ? this.fallBackTo.getTick() : this.source.getTick();
    }

    protected updateValues(): Array<T> {
        const sourceVals = this.source.getAll();
        return sourceVals.length === 0 ? this.fallBackTo.getAll() : sourceVals;
    }
}

export class FlatteningPipe<T> extends Pipe<T> {

    private currentPipe: Pipe<T>;
    private lastSourceTick: number = -1;

    constructor(
        public readonly source: Pipe<Pipe<T>>
    ) {
        super();
        this.currentPipe = Pipe.empty<T>();
        this.listenTo(source);
    }

    protected updateTick(): number | null {
        if (this.source.getTick() > this.lastSourceTick) {
            this.resubscribe();

            const nextValue = this.currentPipe.get();

            // Swapping to an empty pipe should not update the flattened pipe's tick (no new value).
            // Swapping to a pipe with a stale value (e.g. fixed) should count as a new value for this pipe.
            return nextValue == null ? null : Math.max(this.source.getTick(), this.currentPipe.getTick());
        }
        else {
            return this.currentPipe.getTick();
        }
    }

    private resubscribe() {
        const nextPipe = this.source.get() ?? Pipe.empty<T>();

        //if (this.lastPipe != null) {
        this.unlisten(this.currentPipe);
        //}

        this.listenTo(nextPipe);
        this.currentPipe = nextPipe;
        this.lastSourceTick = this.source.getTick();
    }

    protected updateValues(): Array<T> {
        // UpdateTick is guaranteed to have been called, so we don't need to worry about resubscribing.
        return this.currentPipe.getAll();
    }
}

export class FlatteningPipeConcurrent<T> extends Pipe<T> {

    private lastSourceTick: number = -1;
    private allPipes = new Set<Pipe<T>>();
    private lastTicks = new Map<Pipe<T>, number>();

    constructor(
        public readonly source: Pipe<Pipe<T>>
    ) {
        super();
        this.listenTo(source);
    }

    protected updateTick(): number | null {
        if (this.source.getTick() > this.lastSourceTick) {
            this.lastSourceTick = this.source.getTick();

            this.source.getAll().forEach(pipe => {
                this.allPipes.add(pipe);
                this.lastTicks.set(pipe, -1);
                this.listenTo(pipe);
            });
        }

        return [...this.allPipes.values(), this.source].reduce((max, pipe) => Math.max(max, pipe.getTick()), -1);
    }

    protected updateValues(): Array<T> {
        // UpdateTick is guaranteed to have been called, so we don't need to worry about new pipes.
        const changedPipes = [...this.allPipes.values()].filter(pipe => pipe.getTick() > this.lastTicks.get(pipe));
        changedPipes.forEach(pipe => this.lastTicks.set(pipe, pipe.getTick()));
        return changedPipes.map(pipe => pipe.getAll()).flat();
    }
}

export class ErrorCatchingPipe<T, TError> extends Pipe<T | TError> {

    private lastGoodTick = -1;
    private lastError: TError | undefined;

    constructor(
        public readonly source: Pipe<T>,
        public readonly onError: (err: any) => TError | undefined | void
    ) {
        super();
        this.listenTo(source);
    }

    protected updateTick(): number | null {
        try {
            this.source.getAll(); // Just do it to see if the source is about to fire an error
            const sourceTick = this.source.getTick();

            if (this.lastError !== undefined || sourceTick > this.lastGoodTick) {
                this.lastError = undefined;
                this.lastGoodTick = sourceTick;

                return Pipe.globalTick;
            }
            else {
                return null;
            }
        }
        catch (err) {
            if (this.lastError !== undefined) {
                // TODO: Can we do any better than this? This could be a new error, but can we determine that?
                // Consider caching/comparing the error message
                return null;
            }

            this.lastError = err;
            return Pipe.globalTick;
        }
    }

    protected updateValues(): Array<T | TError> {

        if (this.lastError !== undefined) {
            const replacement = this.onError(this.lastError);
            if (replacement === undefined) {
                return [];
            }
            else {
                return [<TError>replacement];
            }
        }
        else {
            return this.source.getAll();
        }
    }
}

export class DebouncingPipe<T> extends Pipe<T> {

    private lastPingTime: number;
    private timeoutHandle: number;
    private isPending: boolean;
    private lastCollectedTick: number;

    constructor(
        public readonly source: Pipe<T>,
        public readonly debounceTimeMs: number
    ) {
        super();
        this.listenTo(source);
        this.lastPingTime = 0;
        this.timeoutHandle = 0;
        this.isPending = false;
        this.lastCollectedTick = -1;
    }

    protected onPing() {
        if (this.isPending) {
            return;
        }

        this.lastPingTime = Date.now();
        this.isPending = true;

        setTimeout(() => {

            this.isPending = false;

            const sourceTick = this.source.getTick();
            if (sourceTick <= this.lastCollectedTick) {
                // We've already buffered these values. TODO: Does this line ever actually run? Why?
                return;
            }

            this.lastCollectedTick = sourceTick;

            const value = this.source.get();

            if (value === undefined) {
                // If the stream has no current value, completely ignore it and don't update the timers.
                return;
            }

            if (this.timeoutHandle > 0) {
                window.clearTimeout(this.timeoutHandle);
                this.timeoutHandle = 0;
            }

            // The TS compiler doesn't get the return type right without "window." here; confusing it with a different setTimeout method?
            this.timeoutHandle = window.setTimeout(() => this.postValues([value]), this.debounceTimeMs);

        }, 0);
    }
}

export class AccumulatingPipe<TIn, TState> extends Pipe<TState> {

    private lastSourceTick = -1;
    private lastValue: TState;

    constructor(
        public readonly source: Pipe<TIn>,
        public readonly accumulate: (state: TState, value: TIn) => TState,
        seed: TState
    ) {
        super();
        this.listenTo(source);
        this.lastValue = seed;
        this.initValues([seed]);
    }

    protected updateTick(): number | null {
        return this.source.getTick();
    }

    protected updateValues(): Array<TState> | null {
        if (this.source.getTick() > this.lastSourceTick) {
            this.lastSourceTick = this.source.getTick();
            const newValues = this.source.getAll();

            if (newValues.length === 0) {
                return null;
            }

            this.lastValue = newValues.reduce(this.accumulate, this.lastValue)
            return [this.lastValue];
        }
        else {
            return null;
        }
    }
}

export class State<T> extends Pipe<T> {

    static new<T>(initialValue?: T) {
        const state = new State<T>();

        if (initialValue !== undefined) {
            state.set(initialValue);
        }

        return state;
    }

    public readonly set: (newValue: T) => void;

    constructor(
    ) {
        super();

        // Declaring with an arrow function allows point-free usage, such as
        // { onclick: state.set } instead of { onclick: e => state.set(e) }
        this.set = val => this.postSingleValue(val);
    }

    /**
     * Changes the value of this State object to a new value by applying the given transformation.
     */
    update(transform: (currentValue: T) => T) {
        // What do we do when we don't have any value yet? We have a few options:
        // 1. Force the transform to explicitly deal with undefined. But this is an implementation detail: we could
        //    just as easily have used a boolean to signify whether we had a value. So undefined should not leak out.
        // 2. Pass undefined unsafely into the transform. This is just option 1 without the consumer knowing about it.
        //    Not ideal.
        // 3. Ignore updates when we have no value yet. The problem is calls like "update(_ => 7)", where the consumer
        //    expects the value to just always get set to 7, regardless of our current state. But we do already have "set" for this.
        // Trying out Option 2 as a balance between the two.

        const currentVal = this.get();

        //if (currentVal !== undefined) {
        this.set(transform(<any>currentVal));
        //}
    }

    // Alias of "update"
    modify(transform: (currentValue: T) => T) {
        this.update(transform);
    }
}

export class Action<T = null> extends Pipe<T> {

    public readonly call: ActionCallSignature<T>;

    constructor(
    ) {
        super();
        this.call = <any>((val: any) => this.postSingleValue(val === undefined ? null : val));

    }
}

export class GatingPipe<T> extends Pipe<T> {

    constructor(
        public readonly gatingValues: Pipe<T>,
        public readonly gatingSignals: Pipe<any>
    ) {
        super();
        this.listenTo(gatingSignals);
    }

    protected updateTick(): number | null {
        return this.gatingSignals.getTick();
    }

    protected updateValues(): Array<T> {
        return this.gatingValues.getAll();
    }
}

export class ProducerPipe<T> extends Pipe<T> {

    constructor(
        public readonly activate: (send: (value: T) => void) => ShutdownFunction
    ) {
        super();

        const send = (value: T) => this.postSingleValue(value);

        let deactivate: ShutdownFunction = () => { };

        // TODO: Should the activate function be behind a 0-timeout?
        this.onFirstListenerAdded(() => deactivate = activate(send));
        this.onLastListenerRemoved(() => {
            deactivate();
            deactivate = () => { };
        });
    }
}

export class ConditionAssertingPipe<T> extends Pipe<T> {

    private getFailureMessage: ((failedValue: T) => string);
    private sourceTrace: string | undefined;

    constructor(
        private source: Pipe<T>,
        private assertion: (item: T) => boolean,
        failureMessage: string | ((failedValue: T) => string)
    ) {
        super();
        this.listenTo(source);
        this.getFailureMessage = (typeof failureMessage === 'string' ? (val => failureMessage) : failureMessage);
        this.sourceTrace = new Error("\n---Source Trace---").stack;
    }

    protected updateTick(): number | null {
        return this.source.getTick();
    }

    protected updateValues(): Array<T> | null {
        const values = this.source.getAll();

        if (values.length === 0) {
            return values;
        }
        else if (values.some(val => !this.assertion(val))) {
            const failingValue = values.find(val => !this.assertion(val));
            throw new Error(`${this.getFailureMessage(failingValue)}\n${this.sourceTrace}\n---Pipe Trace---`);
        }
        else {
            return values;
        }
    }
}

/**
 * Provides very general usage for sending values or linking inputs
 */
export class PipeInput<T = null> extends Pipe<T> {

    private readonly pipes = new Set<Pipe<T>>();
    private readonly delayedPipes = new Map<Pipe<T>, Pipe<T>>();
    private readonly lastTicks = new Map<Pipe<T>, number>();
    private readonly state: State<T>;

    constructor(initialValue?: T) {
        super();
        this.state = State.new(initialValue);
        this.lastTicks.set(this.state, -1);
        this.listenTo(this.state);
    }

    add(...pipesToAdd: Array<Pipe<T>>) {
        for (let pipe of pipesToAdd) {
            this.pipes.add(pipe);

            // PipeInput.add has the possibility of creating cycles.
            // Most real-world cycles can be resolved by introducing a 0-ms delay on the added pipe.
            const delayed = pipe.delay(0);
            this.lastTicks.set(delayed, -1);
            this.listenTo(delayed);

            this.delayedPipes.set(pipe, delayed);
        }
    }

    remove(...pipesToRemove: Array<Pipe<T>>) {
        for (let pipe of pipesToRemove) {
            this.pipes.delete(pipe);

            const delayed = this.delayedPipes.get(pipe);
            this.lastTicks.delete(delayed);
            this.unlisten(delayed);

            this.delayedPipes.delete(pipe);
        }
    }

    has(pipe: Pipe<T>) {
        return this.pipes.has(pipe);
    }

    get members() {
        return [...this.pipes.values()];
    }

    set(newValue: T) {
        this.state.set(newValue);
    }

    call(this: PipeInput<null>) {
        this.state.set(null);
    }

    protected updateTick(): number | null {
        return [...this.delayedPipes.values(), this.state].reduce((max, pipe) => Math.max(max, pipe.getTick()), -1);
    }

    protected updateValues(): Array<T> {
        const changedPipes = [...this.delayedPipes.values(), this.state].filter(pipe => pipe.getTick() > this.lastTicks.get(pipe));
        changedPipes.forEach(pipe => this.lastTicks.set(pipe, pipe.getTick()));
        return changedPipes.flatMap(o => o.getAll());
    }
}

export class UpdatingPipe<T> extends Pipe<T> {

    private lastSourceTick = -1;
    private lastUpdateTick = -1;
    private currentValue: T = undefined;

    constructor(
        public readonly source: Pipe<T>,
        public readonly updates: Pipe<(currentState: T) => T>
    ) {
        super();
        this.listenTo(source, updates);
    }

    protected updateTick(): number | null {
        // A changed source always means a new value
        if (this.source.getTick() > this.lastSourceTick) {
            return Pipe.globalTick;
        }

        // A new update may mean a new value, if the current value can be updated (i.e. is not undefined)
        if (this.updates.getTick() > this.lastUpdateTick && this.currentValue !== undefined) {
            return Pipe.globalTick;
        }

        return null;
    }

    protected updateValues(): Array<T> {

        // If the source has changed, set the current value to its latest.
        if (this.source.getTick() > this.lastSourceTick) {
            this.currentValue = this.source.get();
            this.lastSourceTick = this.source.getTick();
        }

        let val = this.currentValue;

        if (val === undefined) {
            return null;
        }

        // If the updates stream has changed, apply all buffered updates.
        if (this.updates.getTick() > this.lastUpdateTick) {
            this.updates.getAll().forEach(update => val = update(val));
            this.lastUpdateTick = this.updates.getTick();
            this.currentValue = val;
        }

        // Similar to fold, we can't logically buffer more than one value.
        return [val];
    }
}

/*

export class TemplatePipe<T> extends Pipe<T> {

    constructor(
    ) {
        super();
    }

    protected updateTick(): number | null {

    }

    protected updateValues(): Array<T> {

    }
}

*/

interface ActionCallSignature<T> {
    (this: Action<null>): void;
    (this: Action<T>, value: T): void;
    (this: Action<any>, value?: T | undefined): void
};

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
    <T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>): Pipe<[T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11]>;
    <T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>): Pipe<[T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12]>;
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
    <T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>): Pipe<T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 | T11>;
    <T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12>(x1: Pipe<T1>, x2: Pipe<T2>, x3: Pipe<T3>, x4: Pipe<T4>, x5: Pipe<T5>, x6: Pipe<T6>, x7: Pipe<T7>, x8: Pipe<T8>, x9: Pipe<T9>, x10: Pipe<T10>, x11: Pipe<T11>, x12: Pipe<T12>): Pipe<T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 | T11 | T12>;
    <T>(...items: Array<Pipe<T>>): Pipe<T>;
    (...items: Array<Pipe<any>>): Pipe<any>
}

