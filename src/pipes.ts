import { RecencyList } from "./RecencyList";

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

type TraceFunction<T> = () => Array<any>;

interface Lens<TContext, TFocus> {
    get(context: TContext): TFocus;
    set(value: TFocus): (context: TContext) => TContext;
}

export class PipeSignal {
    static readonly noValue = new PipeSignal();

    // TODO: Any other special signals? Examples:
    // closing: no more values to expect
    // error (any examlpes? This would be a pipe-hookup error, not an error value inside of the pipe, right?)
    // expire: clear the pipes (invalidate any remembered values)
    // pending: a new value is pending
    // noData: a signal, but one with no associated data?
}

export interface PipeListener<T> {
    onValue: (value: T) => void;
    //onError: (err: Error) => void;
};

export type SendSignal<T> = (valueOrSignal: T | PipeSignal) => void;

function isPromise(value: any): value is PromiseLike<any> {
    return (typeof value?.then === 'function');
}

export abstract class Pipe<T> {

    static debugMode = false;

    private readonly constructedAt;

    constructor() {
        if (Pipe.debugMode) {
            this.constructedAt = new Error("constructed");
        }
    }

    getConstructionStack() {
        return this.constructedAt;
    }

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

    // Gets the value in the pipe, or returns NoValue if no value is available.
    public abstract get(): T | PipeSignal;

    // Indicates whether the stream caches new values on the first get().
    // Streams with memory behave the same if remember() is called on them.
    public abstract hasMemory: boolean;

    // Subscribes a listener which is synchronously called when this pipe emits a ping.
    // A ping signals that the pipe may have an updated value.
    // Many pings may occur from one atomic change, so checking for the new value should be delayed.
    // This is mostly intended for 
    abstract subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void;

    subscribe(listener: PipeListener<T> | ((value: T) => void)) {

        const sendValue = ("onValue" in listener) ? listener.onValue : listener;

        let valuePending = false;

        const postNewValue = () => {
            valuePending = false;
            const newValue = this.get();

            if (!(newValue instanceof PipeSignal)) {
                sendValue(newValue);
            }
        }

        const unsub = this.subscribePing(onPing, () => [listener]);
        onPing();

        return unsub;

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

    map<TEnd>(projection: (value: T) => (TEnd | PipeSignal)): Pipe<TEnd> {
        return new MapPipe<T, TEnd>(this, projection);
    }

    remember(): Pipe<T> {
        //if (this instanceof MemoryPipe || this instanceof State || this instanceof FixedPipe || this instanceof EmptyPipe) {
        if (this.hasMemory) {
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

    /*
     * Returns a pipe which reproduces the signals of this pipe after (roughly) the given number of millseconds.
     */
    delay(milliseconds: number): Pipe<T> {
        return new DelayingPipe(this, milliseconds);
    }

    debounceGroup(milliseconds: number): Pipe<Array<T>> {
        return new DebouncingPipe(this, milliseconds);
    }

    debounce(milliseconds: number): Pipe<T> {
        return this.debounceGroup(milliseconds)
            .filter(arr => arr.length > 0)
            .map(values => values[values.length - 1]);
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

        unsubscribe = this.subscribe({
            onValue: val => {
                unsubscribe();
                action(val);
            }
            // TODO: Unsubscribe on error
        });
    }

    dropRepeats(equals?: (a: T, b: T) => boolean): Pipe<T> {
        if (!equals) {
            equals = (a, b) => a === b;
        }

        return this
            .fold((last, next) => (last !== undefined && equals!(last, next)) ? undefined : next, <T | undefined>undefined)
            .filter(o => o !== undefined) as Pipe<T>;
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
        return Pipe
            .mergeLabeled({
                value: this,
                transition: updates
            })
            .fold((last, event) => {
                if ('transition' in event) {
                    let current = last.state;

                    if (current instanceof PipeSignal) {
                        current = this.get();
                    }

                    if (current instanceof PipeSignal) {
                        return last;
                    }
                    else {
                        return { state: event.transition!(current), emit: true };
                    }
                }
                else {
                    return { state: event.value!, emit: true }
                }

            }, { state: <PipeSignal | T>PipeSignal.noValue, emit: false })
            .filter(o => o.emit)
            .map(o => o.state)
            .fallbackPipe(this);
    }

    withTransitions<TTransition>(transitions: Pipe<TTransition>, applyTransition: (value: T, transition: TTransition) => T): Pipe<T> {
        const updates = transitions.map(update => (value: T) => applyTransition(value, update));
        return this.withUpdates(updates);
    }

    compose<TResult>(transform: (thisPipe: Pipe<T>) => TResult) {
        return transform(this);
    }

    //fork(): State<T> {

    //    const updates = State.new<T>();


    //    const thing = this.withUpdates(updates, (origVal, newVal) => newVal);
    //    //Object.setPrototypeOf(thing, updates);

    //    return <State<T>>thing;
    //}

    sampleCombine<T2>(addonPipe: Pipe<T2>): Pipe<[T, T2]> {
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

    static merge = function combine(...pipes: Array<Pipe<any>>) {
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

    /**
     * Creates a new collection of pipes that can have pipes added to or removed from it.
     **/
    static collection<T>() {
        return new PipeCollection<T>();
    }

    static producer<T>(activate: (send: SendSignal<T>) => ShutdownFunction): Pipe<T> {
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

    protected debug(message: string) {
        //if (Pipe.debugMode) {
        //    console.log(message, this);
        //}
    }
}

interface OnOff {
    on: () => void;
    off: () => void;
}

export class SubscriptionHolder {
    private nextIndex: number;
    private subscribers: { [subscriberIndex: number]: () => void };
    private tracers: { [subscriberIndex: number]: TraceFunction<any> };

    private proxyCount: number;
    private proxies: { [proxyIndex: number]: OnOff };

    constructor() {
        this.nextIndex = 0;
        this.subscribers = {};
        this.tracers = {};
        this.proxyCount = 0;
        this.proxies = [];
    }

    public subscribePing(onPing: () => void, trace: TraceFunction<any>): () => void {

        const firstSubscription = !this.any();

        const subscriberIndex = this.nextIndex;
        this.subscribers[subscriberIndex] = onPing;
        this.tracers[subscriberIndex] = trace;
        this.nextIndex++;

        if (firstSubscription) {
            // If this is the first subscription, switch all proxy subscriptions on.
            this.forEachProxy(proxy => proxy.on());
        }

        return () => {
            //if (Pipe.debugMode) {
            //    console.log("Unsubscribing: ", this.trace());
            //}

            delete this.subscribers[subscriberIndex];
            delete this.tracers[subscriberIndex];
            if (!this.any()) {
                // If this is the last un-subscription, switch all proxy subscriptions off.
                this.forEachProxy(proxy => proxy.off());
            }
        }
    }

    public any() {
        for (let _key in this.subscribers) {
            return true;
        }

        return false;
    }

    public sendPing() {
        for (let key in this.subscribers) {
            this.subscribers[key]();
        }
    }

    public trace(): Array<any> {
        const results = Object.values(this.tracers).map(trace => trace());

        if (results.length > 1) {
            // This is a branch needing its own sub-array.
            return [results];
        }
        else {
            return results;
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
    public proxySubscribePing(pipe: Pipe<any>, onPing: () => void, selfTrace: () => Array<any>): () => void {

        let unsubscribe: () => void;
        return this.proxyLink(
            () => unsubscribe = pipe.subscribePing(onPing, () => [...selfTrace(), ...this.trace()]),
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

    // For debugging
    private reportLabel: string | undefined;

    get hasMemory() { return true; }

    static new<T>(initialValue?: T) {
        let value = initialValue;

        return new State<T>(
            () => value,
            newValue => value = newValue,
            new SubscriptionHolder()
        );
    }

    public set: (newValue: T) => void;
    private subs: SubscriptionHolder;

    constructor(
        private getFunc: () => T | PipeSignal | undefined,
        private setFunc: (newValue: T) => void,
        subs?: SubscriptionHolder
    ) {
        super();

        this.subs = subs || new SubscriptionHolder();

        // This is defined here in order to bind it to "this", so it can be used point-free.
        // For example, { onclick: state.set }, instead of { onclick: e => state.set(e) }
        this.set = val => {
            if (this.reportLabel) {
                console.log(`Setting ${this.reportLabel}`, val, new Error('set'));
            }

            this.setFunc(val);
            this.subs.sendPing();
        };

        // Need this?
        this.set = this.set.bind(this);

    }

    public get(): T | PipeSignal {
        const value = this.getFunc();
        return value === undefined ? PipeSignal.noValue : value;
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

        const currentVal = this.getFunc();

        //if (currentVal !== undefined) {
        this.set(transform(<any>currentVal));
        //}
    }

    // Alias of "update"
    modify(transform: (currentValue: T) => T) {
        this.update(transform);
    }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");

        if (this.getFunc() !== undefined) {
            // If we have a value, immediately let new subscribers know it's available.
            onPing();
        }

        return this.subs.subscribePing(onPing, trace);
    }

    asPipe(): Pipe<T> {
        return this;
    }

    focus<TFocus>(lens: Lens<T, TFocus>): State<TFocus> {
        return new State(
            () => lens.get(this.get() as T),
            focusVal => this.update(lens.set(focusVal)),
            this.subs
        );
    }

    trace() {
        return [this, ...this.subs.trace()];
    }

    reportSets(label: string) {
        this.reportLabel = label || 'state';
    }
}

export class FilterPipe<T> extends Pipe<T> {

    private isDirty: boolean;
    private cachedResult: T | PipeSignal;

    private readonly subs: SubscriptionHolder;

    constructor(
        public readonly source: Pipe<T>,
        public readonly predicate: (value: T) => boolean
    ) {
        super();
        this.cachedResult = PipeSignal.noValue;
        this.isDirty = true;
        this.subs = new SubscriptionHolder();
        this.subs.proxySubscribePing(source, () => this.onSourcePing(), () => [this]);
    }

    public get(): T | PipeSignal {
        this.updateCachedResult();
        return this.cachedResult;
    }

    get hasMemory() { return false; }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");
        return this.subs.subscribePing(onPing, trace);
    }

    private updateCachedResult() {
        if (!this.isDirty) {
            return;
        }

        this.isDirty = false;
        const sourceResult = this.source.get();

        // Cache the passing value if predicate succeeds, or PipeSignal.noValue if the predicate fails.
        // This ensures only one call to both source.get and this.predicate per received ping.
        if (!(sourceResult instanceof PipeSignal) && this.predicate(sourceResult)) {
            this.cachedResult = sourceResult;
        }
        else {
            this.cachedResult = PipeSignal.noValue;
        }
    }

    private checkAndSend() {
        this.updateCachedResult();

        if (!(this.cachedResult instanceof PipeSignal)) {
            this.subs.sendPing();
        }
    }

    private onSourcePing() {
        if (!this.isDirty) {
            this.isDirty = true;

            // Defer checking the value; in general, get() calls are expected to not be synchronous with pings.
            setTimeout(() => this.checkAndSend(), 0);
        }
    }

    trace() {
        return [this, ...this.subs.trace()];
    }
}


export class MapPipe<TSource, TEnd> extends Pipe<TEnd> {
    private lastResult: TEnd | PipeSignal;
    private isDirty: boolean;
    private readonly subs: SubscriptionHolder;

    constructor(
        public readonly source: Pipe<TSource>,
        public readonly projection: (value: TSource) => (TEnd | PipeSignal)
    ) {
        super();
        this.isDirty = true;
        this.subs = new SubscriptionHolder();
        this.lastResult = PipeSignal.noValue;

        // For safety, map automatically remembers its last signal. This is sometimes wasteful, but prevents a class of
        // difficult-to-debug errors where instances created in the projection are not "shared" in the way the consumer intends.
        // We use a SubscriptionHolder to prevent isDirty from being set inappropriately.
        // This doesn't need to be unsubscribed from because the subscribed object has the same lifetime as the subscribing.
        this.subs.proxySubscribePing(this.source, () => this.onSourcePing(), () => [this]);
    }

    private onSourcePing() {
        this.isDirty = true;
        this.lastResult = PipeSignal.noValue;
        this.subs.sendPing();
    }

    public get(): TEnd | PipeSignal {
        if (!this.isDirty) {
            return this.lastResult;
        }

        const sourceValue = this.source.get();

        if (sourceValue === undefined) {
            this.lastResult = PipeSignal.noValue;
        }
        else if (sourceValue instanceof PipeSignal) {
            this.lastResult = sourceValue;
        }
        else {
            this.lastResult = this.projection(sourceValue);

            if (this.lastResult === undefined) {
                this.lastResult = PipeSignal.noValue;
            }

            if (!(this.lastResult instanceof PipeSignal)) {
                this.isDirty = false;
            }
        }

        return this.lastResult;
    }

    get hasMemory() { return false; }

    subscribePing(onPing: () => void, trace: TraceFunction<TEnd>): () => void {
        this.debug("Subscribing");

        if (!(this.lastResult instanceof PipeSignal)) {
            onPing();
        }

        return this.subs.subscribePing(onPing, trace);
    }
}

export class MemoryPipe<T> extends Pipe<T> {

    private hasValue: boolean;
    private isDirty: boolean;
    private currentValue: T | undefined;

    constructor(
        private source: Pipe<T>
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
        const newValue = this.source.get();

        if (newValue instanceof PipeSignal || newValue === undefined) {
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

    get hasMemory() { return true; }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");

        if (this.hasValue) {
            // Let the subscriber know a value is immediately available.
            onPing();
        }

        return this.source.subscribePing(() => {
            // It's tempting to clear this.currentValue here for memory efficiency, but a ping only
            // tells us there *might* be a new value for us. It could be a "never mind" signal.
            // So we don't know for sure we can forget currentValue yet.

            this.isDirty = true;
            onPing();
        }, () => [this, ...trace()]);
    }

    get value() {
        return this.currentValue;
    }
}

export class CombinedPipe extends Pipe<Array<any>> {

    public readonly pipes: Array<Pipe<any>>;

    constructor(
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

        if (values.some(v => v instanceof PipeSignal || v === undefined)) {
            // TODO: If we introduce more special signals, we have to think about how they combine here.
            return PipeSignal.noValue;
        }
        else {
            return values;
        }
    }

    get hasMemory() { return false; }

    subscribePing(onPing: () => void, trace: TraceFunction<Array<any>>): () => void {
        this.debug("Subscribing");

        const allSubscriptions = this.pipes.map(p => p.subscribePing(onPing, () => [this, ...trace()]));
        return () => allSubscriptions.forEach(unsub => unsub());
    }
}

export class CombinedPipeLabeled<TTemplate extends LabeledPipes> extends Pipe<CombinedLabeled<TTemplate>> {

    public readonly template: LabeledPipes;

    constructor(
        templateObj: TTemplate
    ) {
        super();

        this.template = {};
        for (let key in templateObj) {
            this.template[key] = templateObj[key].remember();
        }
    }

    public get(): CombinedLabeled<TTemplate> | PipeSignal {
        const result: { [key: string]: any } = {};

        for (let key in this.template) {
            const childValue = this.template[key].get();

            if (childValue instanceof PipeSignal) {
                return PipeSignal.noValue;
            }

            result[key] = childValue;
        }

        return result;
    }

    get hasMemory() { return false; }

    subscribePing(onPing: () => void, trace: TraceFunction<CombinedLabeled<TTemplate>>): () => void {
        this.debug("Subscribing");

        const allSubscriptions = Object.values(this.template).map(p => p.subscribePing(onPing, () => [this, ...trace()]));
        return () => allSubscriptions.forEach(unsub => unsub());
    }
}

export class MergedPipe extends Pipe<any> {
    private readonly recentPipes: RecencyList<Pipe<any>>

    constructor(public readonly pipes: Array<Pipe<any>>) {
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
    }

    get hasMemory() { return false; }

    get pipesInRecencyOrder() {
        return [...this.recentPipes];
    }

    subscribePing(onPing: () => void, trace: TraceFunction<any>): () => void {
        this.debug("Subscribing");

        const allSubscriptions = this.recentPipes.items.map(p => p.subscribePing(
            () => this.pingFrom(p, onPing),
            () => [this, ...trace()]
        ));

        return () => allSubscriptions.forEach(unsub => unsub());
    }

    private pingFrom(pipe: Pipe<any>, onPing: () => void) {
        this.recentPipes.setHead(pipe);

        setTimeout(() => {
            const value = pipe.get();
            if (!(value instanceof PipeSignal)) {
                // Do not send a ping if the pipe does not have a value. Otherwise,
                // we can accidentally re-send a previous value from another pipe.
                onPing();
            }
        }, 0);
    }
}

export class FixedPipe<T> extends Pipe<T> {
    constructor(
        public readonly value: T
    ) {
        super();
    }

    public get(): T | PipeSignal {
        return this.value;
    }

    get hasMemory() { return true; }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");

        // Let the subscriber know a value is immediately available.
        onPing();
        return doNothing;
    }
}

export class EmptyPipe<T> extends Pipe<T> {
    public get(): T | PipeSignal {
        return PipeSignal.noValue;
    }

    get hasMemory() { return true; }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");
        return doNothing;
    }
}

export class FlatteningPipe<T> extends Pipe<T> {

    private lastPipe: Pipe<T> | null;
    private unsubscribe: () => void;

    public readonly source: Pipe<Pipe<T>>;
    private readonly subs: SubscriptionHolder;

    constructor(
        sourcePipeOfPipes: Pipe<Pipe<T>>
    ) {
        super();
        this.source = sourcePipeOfPipes.remember();
        this.subs = new SubscriptionHolder();
        this.unsubscribe = doNothing;
        this.lastPipe = null;

        // This doesn't need to be unsubscribed from because the subscribed object has the same lifetime as the subscribing.
        this.subs.proxySubscribePing(this.source, () => this.subs.sendPing(), () => [this]);
    }

    public get(): T | PipeSignal {
        const currentPipe = this.source.get();

        if (currentPipe instanceof PipeSignal) {
            return currentPipe;
        }

        if (currentPipe !== this.lastPipe) {
            this.unsubscribe();
            this.lastPipe = currentPipe;
            this.unsubscribe = currentPipe.subscribePing(() => this.subs.sendPing(), () => [this, ...this.subs.trace()]);
        }

        return currentPipe.get();
    }

    get hasMemory() { return false; }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");
        return this.subs.subscribePing(onPing, trace);
    }

    trace() {
        return [this, ...this.subs.trace()];
    }
}

export class FlatteningPipeConcurrent<T> extends Pipe<T> {
    public readonly source: Pipe<Pipe<T>>;
    private readonly seenPipes: PipeCollection<T>;

    constructor(
        sourcePipeOfPipes: Pipe<Pipe<T>>
    ) {
        super();
        this.source = sourcePipeOfPipes.remember();
        this.seenPipes = new PipeCollection();

        // This doesn't need to be unsubscribed from because the subscribed object has the same lifetime as the subscribing.
        this.seenPipes.subs.proxySubscribePing(this.source, () => this.seenPipes.subs.sendPing(), () => [this]);
    }

    public get(): T | PipeSignal {

        const currentPipe = this.source.get();

        if (currentPipe instanceof PipeSignal) {
            return currentPipe;
        }

        if (!this.seenPipes.has(currentPipe)) {
            this.seenPipes.add(currentPipe);
        }

        return this.seenPipes.get();
    }

    get hasMemory() { return false; }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");
        return this.seenPipes.subscribePing(onPing, trace);
    }

    trace() {
        return [this, ...this.seenPipes.trace()];
    }
}

export class DelayingPipe<T> extends Pipe<T> {

    private currentSignal: T | PipeSignal;
    private readonly subs: SubscriptionHolder;

    constructor(
        private source: Pipe<T>,
        private delayMilliseconds: number
    ) {
        super();
        this.currentSignal = PipeSignal.noValue;
        this.subs = new SubscriptionHolder();
        this.subs.proxySubscribePing(source, () => this.onSourcePing(), () => [this]);
    }

    private onSourcePing() {
        let lastSignal: T | PipeSignal;

        // Get the value on the next frame, but wait to update it.
        setTimeout(() => {
            lastSignal = this.source.get();
        }, 0);

        // Wait to update the current signal value and send a ping synchronously.
        // Keep as a separate timeout: this prevents the additional frame above from adding to our delay.
        setTimeout(() => {
            this.currentSignal = lastSignal;
            this.subs.sendPing();
        }, this.delayMilliseconds)
    }

    get hasMemory() {
        // This stream behaves slightly differently than a remembered version of itself,
        // because a "never mind" signal overwrites its cached value.
        return false;
    }

    public get(): T | PipeSignal {
        return this.currentSignal;
    }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");
        return this.subs.subscribePing(onPing, trace);
    }

    trace() {
        return [this, ...this.subs.trace()];
    }
}

export class FallbackPipe<T> extends Pipe<T> {
    constructor(
        public readonly source: Pipe<T>,
        public readonly getFallbackValue: () => T
    ) {
        super();
    }

    public get(): T | PipeSignal {
        const value = this.source.get();

        if (value instanceof PipeSignal || value === undefined) {
            return this.getFallbackValue();
        }
        else {
            return value;
        }
    }

    get hasMemory() { return false; }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");
        return this.source.subscribePing(onPing, () => [this, ...trace()]);
    }
}

export class FallbackInnerPipe<T> extends Pipe<T> {

    private lastPrimaryHadValue: boolean;

    constructor(
        public readonly source: Pipe<T>,
        public readonly fallBackTo: Pipe<T>
    ) {
        super();
        this.lastPrimaryHadValue = false;
    }

    public get(): T | PipeSignal {
        const value = this.source.get();

        if (value instanceof PipeSignal) {
            this.lastPrimaryHadValue = false;
            return this.fallBackTo.get();
        }
        else {
            this.lastPrimaryHadValue = true;
            return value;
        }
    }

    get hasMemory() { return false; }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");

        const unsubPrimary = this.source.subscribePing(onPing, () => [this, ...trace()]);

        const unsubFallback = this.fallBackTo.subscribePing(() => {
            // Suppress pings if the primary pipe currently has a value.
            // If the primary updates to no value at the same time as the fallback pings, the ping goes through anyway via the primary subscription.
            if (!this.lastPrimaryHadValue) {
                onPing();
            }
        }, () => [this, ...trace()]);

        return () => {
            unsubPrimary();
            unsubFallback();
        };
    }
}

export class ErrorCatchingPipe<T, TError> extends Pipe<T | TError> {
    constructor(
        private source: Pipe<T>,
        private onError: (err: any) => TError | PipeSignal | undefined | void
    ) {
        super();
    }

    public get(): T | TError | PipeSignal {
        try {
            return this.source.get();
        } catch (err) {

            let replacement = this.onError(err);
            if (replacement === undefined) {
                replacement = PipeSignal.noValue;
            }

            return <T | TError | PipeSignal>replacement!;
        }
    }

    get hasMemory() { return false; }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");
        return this.source.subscribePing(onPing, () => [this, ...trace()]);
    }
}

export class DebouncingPipe<T> extends Pipe<Array<T>> {

    private lastPingTime: number;
    private timeoutHandle: number;
    private bufferedValues: Array<T>;
    private subs: SubscriptionHolder;
    private isPending: boolean;

    constructor(
        private source: Pipe<T>,
        private debounceTimeMs: number
    ) {
        super();
        this.bufferedValues = [];
        this.lastPingTime = 0;
        this.timeoutHandle = 0;
        this.subs = new SubscriptionHolder();
        this.subs.proxySubscribePing(source, () => this.onSourcePing(), () => [this]);
        this.isPending = false;
    }

    public get(): T[] | PipeSignal {
        return this.bufferedValues;
    }

    get hasMemory() { return false; }

    private onSourcePing() {

        if (this.isPending) {
            return;
        }

        const delta = Date.now() - this.lastPingTime;
        this.lastPingTime = Date.now();
        this.isPending = true;

        // All logic below depends on getting the value of the source stream, so we wrap it
        // behind a 0-delay timeout
        setTimeout(() => {

            this.isPending = false;

            const value = this.source.get();

            if (value instanceof PipeSignal) {
                // Completely ignore non-value signals
                return;
            }

            if (this.timeoutHandle > 0) {
                window.clearTimeout(this.timeoutHandle);
                this.timeoutHandle = 0;
            }

            if (delta > this.debounceTimeMs) {
                this.bufferedValues = [value];
            }
            else {
                this.bufferedValues.push(value);
            }

            // The TS compiler doesn't get the return type right without "window." here; confusing it with a different setTimeout method?
            this.timeoutHandle = window.setTimeout(() => this.subs.sendPing(), this.debounceTimeMs);

        }, 0);

    }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");
        return this.subs.subscribePing(onPing, trace);
    }

    trace() {
        return [this, ...this.subs.trace()];
    }
}

export class AccumulatingPipe<TIn, TState> extends Pipe<TState> {

    private isDirty: boolean;
    private currentValue: TState;
    private readonly subs: SubscriptionHolder;

    constructor(
        private source: Pipe<TIn>,
        private accumulate: (state: TState, value: TIn) => TState,
        seed: TState
    ) {
        super();
        this.currentValue = seed;
        this.isDirty = false;
        this.subs = new SubscriptionHolder();

        // Use a subscription holder to ensure at most one subscription to the source. Otherwise this.isDirty can be set inappropriately
        // on new subscriptions if a tributary of this.source calls onPing immediately.
        // This doesn't need to be unsubscribed from because the subscribed object has the same lifetime as the subscribing.
        this.subs.proxySubscribePing(this.source, () => this.onSourcePing(), () => [this]);
    }

    private onSourcePing() {
        this.isDirty = true;
        this.subs.sendPing();
    }

    public get(): TState | PipeSignal {
        if (!this.isDirty) {
            return this.currentValue;
        }

        this.isDirty = false;
        const newValue = this.source.get();

        if (newValue instanceof PipeSignal) {
            return this.currentValue;
        }
        else {
            this.currentValue = this.accumulate(this.currentValue, newValue);
            return this.currentValue;
        }
    }

    get hasMemory() { return true; }

    subscribePing(onPing: () => void, trace: TraceFunction<TState>): () => void {
        this.debug("Subscribing");

        if (this.currentValue !== undefined) {
            onPing();
        }

        return this.subs.subscribePing(onPing, trace);


        //return this.source.subscribePing(() => {
        //    this.isDirty = true;
        //    onPing();
        //}, () => [this, ...trace()]);
    }
}

export class PipeCollection<T> extends Pipe<T> {
    private readonly pipes: Set<Pipe<T>>;
    public readonly subs: SubscriptionHolder;

    private mergedPipe: Pipe<T>
    private unsubscribe: () => void;

    constructor() {
        super();
        this.pipes = new Set<Pipe<T>>();
        this.subs = new SubscriptionHolder();
        this.mergedPipe = Pipe.empty<T>();
        this.unsubscribe = doNothing;
    }

    get(): T | PipeSignal {
        return this.mergedPipe.get();
    }

    get hasMemory() { return false; }

    get members() {
        return [...this.pipes.values()];
    }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");
        return this.subs.subscribePing(onPing, trace);
    }

    add(...pipesToAdd: Array<Pipe<T>>) {
        for (let pipe of pipesToAdd) {
            this.pipes.add(pipe);
        }

        this.remerge();
    }

    has(pipe: Pipe<T>) {
        return this.pipes.has(pipe);
    }

    remove(...pipesToRemove: Array<Pipe<T>>) {
        for (let pipe of pipesToRemove) {
            this.pipes.delete(pipe);
        }

        this.remerge();
    }

    trace() {
        return [this, ...this.subs.trace()];
    }

    private remerge() {
        // Wait to unsubscribe from the existing stream. This helps prevent an unncessary cycle of shutoff/startup procedures by preventing
        // the subscriber counts of upstream pipes from hitting 0.
        const cleanup = this.unsubscribe;

        this.mergedPipe = Pipe.merge(...this.pipes.values());
        this.unsubscribe = this.subs.proxySubscribePing(this.mergedPipe, () => this.subs.sendPing(), () => [this]);

        cleanup();

        // Let subscribers know something might have changed, but wait in case
        // synchronous subscriptions are still coming up.
        setTimeout(() => this.subs.sendPing(), 0);
    }
}

/**
 * Combines the functionality of State and PipeCollection to provide
 * very general usage for sending or linking inputs
 * */
export class PipeInput<T = null> extends Pipe<T> {

    private state: State<T>;
    private collection: PipeCollection<T>;
    private merged: Pipe<T>;

    constructor(initialValue?: T) {
        super();
        this.state = State.new<T>(initialValue);
        this.collection = new PipeCollection<T>();
        this.merged = Pipe.merge(this.state, this.collection);
    }

    public get(): PipeSignal | T {
        return this.merged.get();
    }

    get hasMemory() { return false; }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");
        return this.merged.subscribePing(onPing, () => [this, ...trace()]);
    }

    add(...pipesToAdd: Array<Pipe<T>>) {
        this.collection.add(...pipesToAdd);
    }

    remove(...pipesToRemove: Array<Pipe<T>>) {
        this.collection.remove(...pipesToRemove);
    }

    set(newValue: T) {
        this.state.set(newValue);
    }

    call(this: PipeInput<null>) {
        this.state.set(null);
    }

    asPipe(): Pipe<T> {
        return this;
    }

    asState(): State<T> {
        return this.state.focus({
            get: () => this.merged.get(),
            set: (value) => orig => {
                return (value instanceof PipeSignal) ? orig : value;
            }
        }) as any;
    }

    trace() {
        // Any subscribers must also be subscribed to this state, so we can just start tracing there.
        return [this, ...this.state.trace()];
    }

    /**
     * Changes the current value to a new value by applying the given transformation.
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


    static new<T>(initialValue?: T) {
        return new PipeInput<T>(initialValue);
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
        this.getFailureMessage = (typeof failureMessage === 'string' ? (val => failureMessage) : failureMessage);
        this.sourceTrace = new Error("\n---Source Trace---").stack;
    }

    get(): T | PipeSignal {
        const val = this.source.get();

        if (val instanceof PipeSignal) {
            return val;
        }
        else if (!this.assertion(val)) {
            throw new Error(`${this.getFailureMessage(val)}\n${this.sourceTrace}\n---Pipe Trace---`);
        }
        else {
            return val;
        }
    }

    get hasMemory() { return false; }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");
        return this.subscribePing(onPing, () => [this, ...trace()]);
    }
}

export class ProducerPipe<T> extends Pipe<T> {
    private subs: SubscriptionHolder;
    private deactivate: () => void;
    private lastValue: T | PipeSignal | undefined;

    constructor(
        public activate: (send: SendSignal<T>) => ShutdownFunction
    ) {
        super();

        this.deactivate = () => { };
        this.subs = new SubscriptionHolder();
        this.subs.proxyLink(
            () => {
                this.deactivate = activate(val => this.send(val));
            },
            () => {
                this.deactivate();
                this.lastValue = undefined;
            }
        );
    }

    private send(value: T | PipeSignal) {
        this.lastValue = value;
        this.subs.sendPing();
    }

    public get(): T | PipeSignal {
        if (this.lastValue === undefined) {
            return PipeSignal.noValue;
        }

        return this.lastValue;
    }

    get hasMemory() { return false; }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");
        return this.subs.subscribePing(onPing, trace);
    }

    trace() {
        return [this, ...this.subs.trace()];
    }
}

export class Action<T = null> extends Pipe<T> {
    private subs: SubscriptionHolder;
    private lastValue: T | PipeSignal | undefined;
    public readonly call: ActionCallSignature<T>;

    constructor() {
        super();
        this.subs = new SubscriptionHolder();

        // If all subscriptions to this action are closed, we want to forget the last value sent.
        this.subs.proxyLink(
            () => { },
            () => {
                this.lastValue = undefined;
            }
        );

        this.call = <any>((value?: T | undefined) => {

            if (value === undefined) {
                // A lastValue of undefined indicates no signal has been sent yet.
                // We use null for cases where the signal is important, but there's no specific value.
                this.lastValue = <any>null;
            }
            else {
                this.lastValue = value;
            }

            this.subs.sendPing();
        });
    }

    public get(): T | PipeSignal {
        return (this.lastValue === undefined) ? PipeSignal.noValue : this.lastValue;
    }

    get hasMemory() { return false; }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");
        return this.subs.subscribePing(onPing, trace);
    }

    trace() {
        return [this, ...this.subs.trace()];
    }
}

export class GatingPipe<T> extends Pipe<T> {

    private refreshNextValue: boolean;
    private lastAllowedValue: T | PipeSignal;

    constructor(
        public readonly values: Pipe<T>,
        public readonly signals: Pipe<any>
    ) {
        super();
        this.refreshNextValue = false;
        this.lastAllowedValue = PipeSignal.noValue;
    }

    subscribePing(onPing: () => void, trace: TraceFunction<T>): () => void {
        this.debug("Subscribing");

        // Ignore pings from the value stream, but still subscribe to turn everything on.
        const unsubValues = this.values.subscribePing(() => { }, () => [this]);

        const unsubSignals = this.signals.subscribePing(() => {
            this.refreshNextValue = true;
            onPing();
        }, trace);

        return () => {
            unsubSignals();
            unsubValues();
        }
    }

    public get(): T | PipeSignal {
        if (this.refreshNextValue) {
            this.refreshNextValue = false;
            this.lastAllowedValue = this.values.get();
        }

        return this.lastAllowedValue;
    }

    get hasMemory() { return false; }
}

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
