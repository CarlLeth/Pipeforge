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
        lastCycle: null as Pipe<any> | null
    };

    constructor() {
        if (Pipe.debug.isTracing) {
            (this as any)['trace'] = new Error();
        }
    }

    // -- Static recordkeeping --

    private static livePipes = new Set<Pipe<any>>();

    protected static globalBatch = 0;
    private static globalBatchUpdated = false;

    protected static updateGlobalBatch() {
        if (!Pipe.globalBatchUpdated) {
            Pipe.globalBatch++;
            Pipe.globalBatchUpdated = true;
            setTimeout(() => Pipe.globalBatchUpdated = false);
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

    getVersion() {
        this.updateIfNecessary();
        return this.localVersion;
    }

    subscribe(onValue: (value: T) => void) {
        this.subscribers.add(onValue);
        this.checkForFirstListener();

        // Force this pipe to stay alive
        Pipe.livePipes.add(this);

        const unsubscribe = () => {
            this.subscribers.delete(onValue);
            this.checkForLastListener();

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
    // The batch containing the current values. Values posted in one batch are accumulated.
    private localBatch = -1;
    // A pipe-local version. Unlike the batch, this changes for every update.
    private localVersion = -1;
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
            try {
                // A dirty state means that a source ping was received. The update
                // calculation determines whether that ping results in new values
                // being emitted from this pipe.
                const nextValues = this.updateValues();

                if (nextValues !== null) {
                    this.values = nextValues;
                    this.localVersion++;
                }
            }
            finally {
                this.isUpdating = false;
                this.isDirty = false;
            }
        }
    }
    /**
     * Recalculates and returns the latest values for this pipe, or null if the values should not change.
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
        if (!this.isOn && (this.weakListeners.size + this.subscribers.size) > 0) {
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
        if (this.getVersion() <= this.lastBroadcastTick) {
            return;
        }

        this.lastBroadcastTick = this.getVersion();

        const nextValue = this.get();
        if (nextValue !== undefined) {
            this.subscribers.forEach(send => send(nextValue));
        }
    }

    protected listenTo(...sourcePipes: Array<Pipe<any>>) {
        Pipe.updateGlobalBatch();

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
            Pipe.updateGlobalBatch();
            this.values = values;
            this.isDirty = false;
            this.localBatch = Pipe.globalBatch;
            this.localVersion++;
            this.pingListeners();
        }
    }

    protected initValues(values: Array<T>) {
        if (values.length > 0) {
            this.values = values;
            this.localBatch = 0;
            this.localVersion++;
            this.pingListeners();
        }
    }

    protected postSingleValue(value: T) {
        Pipe.updateGlobalBatch();

        if (this.localBatch === Pipe.globalBatch) {
            // Accumulate values that are posted in the same cycle.
            this.values = [...this.values, value];
        }
        else {
            // This is the first value posted this cycle.
            this.values = [value];
        }

        this.isDirty = false;
        this.localBatch = Pipe.globalBatch;
        this.localVersion++;
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
            .fold((last, next) => (last.val !== undefined && equals!(last.val, next)) ? { keep: false, val: next } : { keep: true, val: next }, { keep: true, val: undefined as T | undefined })
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
        return Pipe.merge(...pipesWithLabels) as any as Pipe<MergedLabeled<TTemplate>>;
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
            const handle = setInterval(() => send(null), periodMs);
            return () => clearInterval(handle);
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

    private lastSourceVersion = -1;

    constructor(
        public readonly source: Pipe<T>,
        public readonly predicate: (value: T) => boolean
    ) {
        super();
        this.listenTo(source);
    }

    protected updateValues(): Array<T> | null {

        const sourceVersion = this.source.getVersion();

        if (sourceVersion <= this.lastSourceVersion) {
            return null;
        }

        const values = this.source.getAll().filter(val => this.predicate(val));
        this.lastSourceVersion = sourceVersion;

        return values.length > 0 ? values : null;
    }
}

export class MapPipe<TSource, TEnd> extends Pipe<TEnd> {

    private lastSourceVersion = -1;

    constructor(
        public readonly source: Pipe<TSource>,
        public readonly projection: (value: TSource) => TEnd | undefined
    ) {
        super();
        this.listenTo(source);
    }

    protected updateValues(): Array<TEnd> | null {
        const sourceTick = this.source.getVersion();

        if (sourceTick <= this.lastSourceVersion) {
            return null;
        }

        const values = this.source.getAll()
            .map(val => this.projection(val))
            .filter(val => val !== undefined) as Array<TEnd>;

        this.lastSourceVersion = sourceTick;

        return values.length > 0 ? values : null;
    }
}

export class CombinedPipe extends Pipe<Array<any>> {

    private latestVersions: Array<number>;

    constructor(
        public readonly pipes: Array<Pipe<any>>
    ) {
        super();
        this.latestVersions = pipes.map(_ => -1);
        this.listenTo(...pipes);

        if (pipes.length === 0) {
            // A combination of 0 pipes is the same a Pipe.fixed([]).
            this.postSingleValue([]);
        }
    }

    protected updateValues(): Array<Array<any>> | null {

        if (!this.pipes.some((pipe, i) => pipe.getVersion() > this.latestVersions[i])) {
            // No pipes have updated values
            return null;
        }

        const latestValues = this.pipes.map(pipe => pipe.get());
        if (latestValues.some(val => val === undefined)) {
            // If any pipes have undefined values, do not emit anything.
            return null;
        }

        this.latestVersions = this.pipes.map(pipe => pipe.getVersion());

        return [latestValues];
    }

}

export class CombinedPipeLabeled<TTemplate extends LabeledPipes> extends Pipe<CombinedLabeled<TTemplate>> {

    private latestVersions: Record<string, number>;

    constructor(
        public readonly template: TTemplate
    ) {
        super();
        this.latestVersions = {};

        let anyKeys = false;
        for (const key in template) {
            anyKeys = true;
            this.latestVersions[key] = -1;
        }

        this.listenTo(...Object.values(template));

        if (!anyKeys) {
            // A labeled combination of 0 pipes is the same as Pipe.fixed({}).
            this.postSingleValue(<CombinedLabeled<TTemplate>>{});
        }
    }

    protected updateValues(): Array<CombinedLabeled<TTemplate>> | null {
        if (!Object.keys(this.template).some(key => this.template[key].getVersion() > this.latestVersions[key])) {
            // No pipes have updated values
            return null;
        }

        for (const key in this.template) {
            if (this.template[key].get() === undefined) {
                // If any pipes have undefined values, do not emit anything.
                return null;
            }
        }

        const result: { [key: string]: any } = {};
        for (const key in this.template) {
            this.latestVersions[key] = this.template[key].getVersion();
            result[key] = this.template[key].get();
        }

        return [<CombinedLabeled<TTemplate>>result];
    }
}

export class MergedPipe extends Pipe<any> {

    private lastVersions: Array<number>;

    constructor(
        public readonly pipes: Array<Pipe<any>>
    ) {
        super();
        this.listenTo(...pipes);
        this.lastVersions = pipes.map(_ => -1);
    }

    protected updateValues(): Array<any> | null {
        const changedPipes = this.pipes.filter((pipe, i) => pipe.getVersion() > this.lastVersions[i]);
        if (changedPipes.length === 0) {
            return null;
        }

        this.lastVersions = this.pipes.map(pipe => pipe.getVersion());
        const values = changedPipes.map(pipe => pipe.getAll()).flat();
        return values.length > 0 ? values : null;
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
}

export class DelayingPipe<T> extends Pipe<T> {

    private lastSourceVersion = -1;

    constructor(
        public readonly source: Pipe<T>,
        public readonly delayMilliseconds: number
    ) {
        super();
        this.listenTo(source);
    }

    protected onPing() {
        setTimeout(() => {
            const sourceVersion = this.source.getVersion();

            if (sourceVersion <= this.lastSourceVersion) {
                return;
            }

            this.lastSourceVersion = sourceVersion;
            const values = this.source.getAll();

            setTimeout(() => {
                this.postValues(values);
            }, this.delayMilliseconds);
        }, 0);
    }
}

export class FallbackPipe<T> extends Pipe<T> {

    private lastSourceVersion = -2;

    constructor(
        public readonly source: Pipe<T>,
        public readonly getFallbackValue: () => T
    ) {
        super();
        this.listenTo(source);
    }

    protected updateValues(): Array<T> | null {
        if (this.source.getVersion() <= this.lastSourceVersion) {
            return null;
        }

        this.lastSourceVersion = this.source.getVersion();
        const sourceVals = this.source.getAll();
        return sourceVals.length === 0 ? [this.getFallbackValue()] : sourceVals;
    }
}

export class FallbackInnerPipe<T> extends Pipe<T> {

    private lastSourceVersion = -1;
    private lastFallbackVersion = -1;

    constructor(
        public readonly source: Pipe<T>,
        public readonly fallBackTo: Pipe<T>
    ) {
        super();
        this.listenTo(source, fallBackTo);
    }

    protected updateValues(): Array<T> | null {
        const sourceChanged = this.source.getVersion() > this.lastSourceVersion;
        const fallbackChanged = this.fallBackTo.getVersion() > this.lastFallbackVersion;

        if (!sourceChanged && !fallbackChanged) {
            return null;
        }

        this.lastSourceVersion = this.source.getVersion();
        this.lastFallbackVersion = this.fallBackTo.getVersion();

        const sourceVals = this.source.getAll();
        const selectedValues = sourceVals.length === 0 ? this.fallBackTo.getAll() : sourceVals;
        if (selectedValues.length === 0) {
            return null;
        }

        return selectedValues;
    }
}

export class FlatteningPipe<T> extends Pipe<T> {

    private currentPipe: Pipe<T>;
    private lastSourceVersion: number = -1;
    private lastCurrentVersion: number = -1;

    constructor(
        public readonly source: Pipe<Pipe<T>>
    ) {
        super();
        this.currentPipe = Pipe.empty<T>();
        this.listenTo(source);
    }

    protected updateValues(): Array<T> | null {
        const sourceChanged = this.source.getVersion() > this.lastSourceVersion;
        if (sourceChanged) {
            this.resubscribe();
        }

        const currentValues = this.currentPipe.getAll();
        if (currentValues.length === 0) {
            return null;
        }

        if (!sourceChanged && this.currentPipe.getVersion() <= this.lastCurrentVersion) {
            return null;
        }

        this.lastCurrentVersion = this.currentPipe.getVersion();
        return currentValues;
    }

    private resubscribe() {
        const nextPipe = this.source.get() ?? Pipe.empty<T>();

        this.unlisten(this.currentPipe);

        this.listenTo(nextPipe);
        this.currentPipe = nextPipe;
        this.lastSourceVersion = this.source.getVersion();
    }

}

export class FlatteningPipeConcurrent<T> extends Pipe<T> {

    private lastSourceVersion: number = -1;
    private allPipes = new Set<Pipe<T>>();
    private lastVersions = new Map<Pipe<T>, number>();

    constructor(
        public readonly source: Pipe<Pipe<T>>
    ) {
        super();
        this.listenTo(source);
    }

    protected updateValues(): Array<T> | null {
        if (this.source.getVersion() > this.lastSourceVersion) {
            this.lastSourceVersion = this.source.getVersion();

            this.source.getAll().forEach(pipe => {
                if (!this.allPipes.has(pipe)) {
                    this.allPipes.add(pipe);
                    this.lastVersions.set(pipe, -1);
                    this.listenTo(pipe);
                }
            });
        }

        const changedPipes = [...this.allPipes].filter(pipe =>
            pipe.getVersion() > this.lastVersions.get(pipe)! && pipe.getAll().length > 0
        );

        const allChangedPipes = [...this.allPipes].filter(pipe => pipe.getVersion() > this.lastVersions.get(pipe)!);
        allChangedPipes.forEach(pipe => this.lastVersions.set(pipe, pipe.getVersion()));

        const values = changedPipes.map(pipe => pipe.getAll()).flat();
        return values.length > 0 ? values : null;
    }
}

export class ErrorCatchingPipe<T, TError> extends Pipe<T | TError> {

    private lastGoodVersion = -1;

    constructor(
        public readonly source: Pipe<T>,
        public readonly onError: (err: any) => TError | undefined | void
    ) {
        super();
        this.listenTo(source);
    }

    protected updateValues(): Array<T | TError> | null {
        try {
            // This must happen before checking the version: source evaluation may throw.
            const values = this.source.getAll();
            const sourceVersion = this.source.getVersion();

            if (sourceVersion <= this.lastGoodVersion) {
                return null;
            }

            this.lastGoodVersion = sourceVersion;
            return values.length > 0 ? values : null;
        }
        catch (error) {
            const replacement = this.onError(error);
            return replacement === undefined ? null : [replacement as TError];
        }
    }
}

export class DebouncingPipe<T> extends Pipe<T> {

    private timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    private isPending: boolean;
    private lastCollectedVersion: number;

    constructor(
        public readonly source: Pipe<T>,
        public readonly debounceTimeMs: number
    ) {
        super();
        this.listenTo(source);
        this.timeoutHandle = undefined;
        this.isPending = false;
        this.lastCollectedVersion = -1;
    }

    protected onPing() {
        if (this.isPending) {
            return;
        }

        this.isPending = true;

        setTimeout(() => {

            this.isPending = false;

            const sourceVersion = this.source.getVersion();
            if (sourceVersion <= this.lastCollectedVersion) {
                // We've already buffered these values. TODO: Does this line ever actually run? Why?
                return;
            }

            this.lastCollectedVersion = sourceVersion;

            const value = this.source.get();

            if (value === undefined) {
                // If the stream has no current value, completely ignore it and don't update the timers.
                return;
            }

            if (this.timeoutHandle !== undefined) {
                clearTimeout(this.timeoutHandle);
                this.timeoutHandle = undefined;
            }

            this.timeoutHandle = setTimeout(() => this.postValues([value]), this.debounceTimeMs);

        }, 0);
    }
}

export class AccumulatingPipe<TIn, TState> extends Pipe<TState> {

    private lastSourceTick = -1;
    private lastSourceBatch = -1;
    private batchProcessedValues = 0;

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

    protected updateValues(): Array<TState> | null {
        if (this.source.getVersion() > this.lastSourceTick) {

            if (Pipe.globalBatch > this.lastSourceBatch) {
                this.batchProcessedValues = 0;
            }

            this.lastSourceTick = this.source.getVersion();
            this.lastSourceBatch = Pipe.globalBatch;

            let newValues = this.source.getAll();

            if (this.batchProcessedValues > 0) {
                newValues = newValues.slice(this.batchProcessedValues);
            }

            if (newValues.length === 0) {
                return null;
            }

            this.batchProcessedValues += newValues.length;

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

    private lastGatingVersion = -1;

    constructor(
        public readonly gatingValues: Pipe<T>,
        public readonly gatingSignals: Pipe<any>
    ) {
        super();
        this.listenTo(gatingSignals);
    }

    protected updateValues(): Array<T> | null {
        if (this.gatingSignals.getVersion() <= this.lastGatingVersion) {
            return null;
        }

        if (this.gatingValues.getAll().length === 0) {
            return null;
        }

        this.lastGatingVersion = this.gatingSignals.getVersion();
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

    private lastSourceVersion = -1;
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

    protected updateValues(): Array<T> | null {
        if (this.source.getVersion() <= this.lastSourceVersion) {
            return null;
        }

        const values = this.source.getAll();

        if (values.length === 0) {
            return null;
        }

        this.lastSourceVersion = this.source.getVersion();

        const failingValue = values.find(val => !this.assertion(val));
        if (failingValue === undefined) {
            return values;
        }
        else {
            throw new Error(`${this.getFailureMessage(failingValue)}\n${this.sourceTrace}\n---Pipe Trace---`);
        }
    }
}

/**
 * Provides very general usage for sending values or linking inputs
 */
export class PipeInput<T = null> extends Pipe<T> {

    private readonly pipes = new Set<Pipe<T>>();
    private readonly delayedPipes = new Map<Pipe<T>, Pipe<T>>();
    private readonly lastVersions = new Map<Pipe<T>, number>();
    private readonly state: State<T>;

    constructor(initialValue?: T) {
        super();
        this.state = State.new(initialValue);
        this.lastVersions.set(this.state, -1);
        this.listenTo(this.state);
    }

    add(...pipesToAdd: Array<Pipe<T>>) {
        for (let pipe of pipesToAdd) {
            this.pipes.add(pipe);

            // PipeInput.add has the possibility of creating cycles.
            // Most real-world cycles can be resolved by introducing a 0-ms delay on the added pipe.
            const delayed = pipe.delay(0);
            this.lastVersions.set(delayed, -1);
            this.listenTo(delayed);

            this.delayedPipes.set(pipe, delayed);
        }
    }

    remove(...pipesToRemove: Array<Pipe<T>>) {
        for (let pipe of pipesToRemove) {
            this.pipes.delete(pipe);

            const delayed = this.delayedPipes.get(pipe);

            if (delayed !== undefined) {
                this.lastVersions.delete(delayed);
                this.unlisten(delayed);
            }

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

    protected updateValues(): Array<T> | null {
        const changedPipes = [...this.delayedPipes.values(), this.state]
            .filter(pipe => pipe.getVersion() > this.lastVersions.get(pipe)!);

        changedPipes.forEach(pipe => this.lastVersions.set(pipe, pipe.getVersion()));

        const values = changedPipes.flatMap(o => o.getAll());
        return values.length > 0 ? values : null;
    }
}

export class UpdatingPipe<T> extends Pipe<T> {

    private lastSourceVersion = -1;
    private lastUpdateVersion = -1;
    //private currentValue: T | undefined = undefined;

    constructor(
        public readonly source: Pipe<T>,
        public readonly updates: Pipe<(currentState: T) => T>
    ) {
        super();
        this.listenTo(source, updates);
    }

    protected updateValues(): Array<T> | null {

        if (this.source.getVersion() === this.lastSourceVersion && this.updates.getVersion() === this.lastUpdateVersion) {
            return null;
        }

        if (this.source.getVersion() > this.lastSourceVersion) {
            
        }

        let val = this.source.get();

        if (val === undefined) {
            return null;
        }

        // If the updates stream has changed, apply all buffered updates.
        if (this.updates.getVersion() > this.lastUpdateVersion) {
            this.updates.getAll().forEach(update => val = update(val!));
        }

        this.lastSourceVersion = this.source.getVersion();
        this.lastUpdateVersion = this.updates.getVersion();

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

