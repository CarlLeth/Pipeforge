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
    static empty<T>() : Pipe<T> {
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

    // Subscribes a listener which is synchronously called when this pipe emits a ping.
    // A ping signals that the pipe may have an updated value.
    // Many pings may occur from one atomic change, so checking for the new value should be delayed.
    // This is mostly intended for 
    abstract subscribePing(onPing: () => void): () => void;

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

    map<TEnd>(projection: (value: T) => (TEnd | PipeSignal)): Pipe <TEnd> {
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
        return this.debounceGroup(milliseconds).map(values => values[values.length - 1]);
    }

    /*
     * Returns a stream based on this one that is guaranteed to have a value at all times. Whenever this
     * stream has a value, that value is returned; otherwise, the given fallback value is returned.
     */
    fallback(getFallbackValue: () => T): Pipe<T>
    {
        return new FallbackPipe(this, getFallbackValue);
    }

    fallbackValue(fixedFallbackValue: T): Pipe<T> {
        return new FallbackPipe(this, () => fixedFallbackValue);
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

    /**
     * Returns a new pipe that checks the given condition against each value and throws an error if the value does not meet the condition.
     * @param assertion
     * @param failureMessage
     */
    assert(assertion: (value: T) => boolean, failureMessage: string | ((failedValue: T) => string)): Pipe<T> {
        return new ConditionAssertingPipe(this, assertion, failureMessage);
    }

    /**
     * Returns a new pipe whose value is the latest value sent by this pipe, modified by any transitions that
     * were sent by the given pipe since the last new value. New values from this pipe will overwrite any transitions
     * that have occurred.
     * @param transitions
     */
    withTransitions(transitions: Pipe<(currentState: T) => T>): Pipe<T> {
        return Pipe
            .mergeLabeled({
                value: this,
                transition: transitions
            })
            .fold((last, event) => {
                if ('transition' in event) {
                    if (last.state instanceof PipeSignal) {
                        return last;
                    }
                    else {
                        return { state: event.transition!(last.state), emit: true };
                    }
                }
                else {
                    return { state: event.value!, emit: true }
                }

            }, { state: <PipeSignal | T>PipeSignal.noValue, emit: false })
            .filter(o => o.emit)
            .map(o => o.state)
            .remember();
    }

    withUpdates<TUpdate>(updates: Pipe<TUpdate>, applyUpdate: (value: T, update: TUpdate) => T): Pipe<T> {
        const transitions = updates.map(update => (value: T) => applyUpdate(value, update));
        return this.withTransitions(transitions);
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

    //stateMachine<TState>(onChange: (state: State<TState>, value: T) => void): Pipe<TState> {

    //    const result = State.new<TState>();

    //    const subs = new SubscriptionHolder();



    //    return result;
    //}

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

    static new<T>(initialValue?: T) {
        let value = initialValue;

        return new State<T>(
            //() => value === undefined ? PipeSignal.noValue : value,
            () => value,
            newValue => value = newValue
        );
    }

    private subs: SubscriptionHolder;

    constructor(
        //private value?: T
        //private getFunc: () => T | PipeSignal,
        private getFunc: () => T | undefined,
        private setFunc: (newValue: T) => void
    ) {
        super();
        this.subs = new SubscriptionHolder();
    }

    public get(): T | PipeSignal {
        const value = this.getFunc();
        return value === undefined ? PipeSignal.noValue : value;
    }

    public set(newValue: T) {
        this.setFunc(newValue);
        this.subs.sendPing();
    }

    /**
     * Changes the value of this State object to a new value by applying the given transformation.
     * If this State object has no current value, nothing happens -- the transform is not executed and the state is not changed.
     */
    update(transform: (currentValue: T) => T) {
        // What do we do when we don't have any value yet? We have a few options:
        // 1. Force the transform to explicitly deal with undefined. But this is an implementation detail: we could
        //    just as easily have used a boolean to signify whether we had a value. So undefined should not leak out.
        // 2. Pass undefined unsafely into the transform. This is just option 1 without the consumer knowing about it.
        //    Not ideal.
        // 3. Ignore updates when we have no value yet. The problem is calls like "update(_ => 7)", where the consumer
        //    expects the value to just always get set to 7, regardless of our current state. But we do already have "set" for this.
        // Option 3 seems best.

        const currentVal = this.getFunc();

        if (currentVal !== undefined) {
            this.set(transform(currentVal));
        }
    }

    subscribePing(onPing: () => void): () => void {
        if (this.getFunc() !== undefined) {
            // If we have a value, immediately let new subscribers know it's available.
            onPing();
        }

        return this.subs.subscribePing(onPing);
    }

    asPipe(): Pipe<T> {
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
        private projection: (value: TStart) => (TEnd | PipeSignal)
    ) {
        super();
    }

    public get(): TEnd | PipeSignal {
        const parentValue = this.parent.get();

        if (parentValue === undefined) {
            return PipeSignal.noValue;
        }
        else if (parentValue instanceof PipeSignal) {
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

export class CombinedPipeLabeled<TTemplate extends LabeledPipes> extends Pipe<CombinedLabeled<TTemplate>> {

    private template: LabeledPipes;

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

    subscribePing(onPing: () => void): () => void {
        const allSubscriptions = Object.values(this.template).map(p => p.subscribePing(onPing));
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
        this.lastPingTime = Date.now();

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

export class PipeCollection<T> extends Pipe<T> {
    private pipes: Set<Pipe<T>>;
    private mergedPipe: Pipe<T>
    private subs: SubscriptionHolder;
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

    subscribePing(onPing: () => void): () => void {
        return this.subs.subscribePing(onPing);
    }

    add(...pipesToAdd: Array<Pipe<T>>) {
        for (let pipe of pipesToAdd) {
            this.pipes.add(pipe);
        }

        this.remerge();
    }

    remove(...pipesToRemove: Array<Pipe<T>>) {
        for (let pipe of pipesToRemove) {
            this.pipes.delete(pipe);
        }

        this.remerge();
    }

    private remerge() {
        // Wait to unsubscribe from the existing stream. This helps prevent an unncessary cycle of shutoff/startup procedures by preventing
        // the subscriber counts of upstream pipes from hitting 0.
        const cleanup = this.unsubscribe;

        this.mergedPipe = Pipe.merge(...this.pipes.values());
        this.unsubscribe = this.subs.proxySubscribePing(this.mergedPipe, () => this.subs.sendPing());

        cleanup();
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

    subscribePing(onPing: () => void): () => void {
        return this.merged.subscribePing(onPing);
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

    send(this: PipeInput<null>) {
        this.state.set(null);
    }

    asPipe(): Pipe<T> {
        return this;
    }

    static new<T>(initialValue?: T) {
        return new PipeInput<T>(initialValue);
    }
}

export class ConditionAssertingPipe<T> extends Pipe<T> {
    private getFailureMessage: ((failedValue: T) => string);
    private sourceTrace: string | undefined;

    constructor(
        private parent: Pipe<T>,
        private assertion: (item: T) => boolean,
        failureMessage: string | ((failedValue: T) => string)
    ) {
        super();
        this.getFailureMessage = (typeof failureMessage === 'string' ? (val => failureMessage) : failureMessage);
        this.sourceTrace = new Error("\n---Source Trace---").stack;
    }

    get(): T | PipeSignal {
        const val = this.parent.get();

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

    subscribePing(onPing: () => void): () => void {
        return this.subscribePing(onPing);
    }
}

export class ProducerPipe<T> extends Pipe<T> {
    private subs: SubscriptionHolder;
    private deactivate: () => void;
    private currentValue: T | PipeSignal | undefined;

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
                this.currentValue = undefined;
            }
        );
    }

    private send(value: T | PipeSignal) {
        this.currentValue = value;
        this.subs.sendPing();
    }

    public get(): T | PipeSignal {
        if (this.currentValue === undefined) {
            return PipeSignal.noValue;
        }

        return this.currentValue;
    }

    subscribePing(onPing: () => void): () => void {
        return this.subs.subscribePing(onPing);
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