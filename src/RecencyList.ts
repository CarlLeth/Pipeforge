export class RecencyList<T> implements Iterable<T> {
    public readonly items: Array<T>;

    private indicesByItem: Map<T, number>;

    private headIndex: number;

    // For the item at items[i], store its next and previous indexes in order.
    // The first item is items[head],
    // the second item is items[nextIndices[head]],
    // the third item is items[nextIndices[nextIndices[head]]], etc.
    private nextIndices: Array<number | null>;
    private previousIndices: Array<number>;

    constructor(
        itemsInInitialOrder: Array<T>
    ) {
        this.items = itemsInInitialOrder;
        this.headIndex = 0;
        this.indicesByItem = new Map<T, number>(itemsInInitialOrder.map((item, i) => [item, i]));

        this.nextIndices = Array.from({ length: itemsInInitialOrder.length }, (_, i) => i === itemsInInitialOrder.length - 1 ? null : i + 1);
        this.previousIndices = Array.from({ length: itemsInInitialOrder.length }, (_, i) => i - 1);
    }

    *[Symbol.iterator](): Iterator<T, any, undefined> {
        let i: number | null = this.items.length === 0 ? null : this.headIndex;

        while (i !== null) {
            yield this.items[i];
            i = this.nextIndices[i];
        }
    }

    setHead(newHead: T) {

        if (!this.indicesByItem.has(newHead)) {
            throw new Error(`Attempted to set the new head of a recency list to an item that is not contained in the list.`);
        }

        const newHeadIndex = this.indicesByItem.get(newHead)!;

        if (this.headIndex === newHeadIndex || this.items.length === 0) {
            return;
        }

        // "Patch" the gap left by the moving item, by linking its (former) previous item to its next.
        this.nextIndices[this.previousIndices[newHeadIndex]] = this.nextIndices[newHeadIndex];
        const oldNext = this.nextIndices[newHeadIndex];

        if (oldNext != null) {
            this.previousIndices[oldNext] = this.previousIndices[newHeadIndex];
        }

        // Move the item. The previous index of the head item is ignored, so no need to update.
        this.previousIndices[this.headIndex] = newHeadIndex;
        this.nextIndices[newHeadIndex] = this.headIndex;
        this.headIndex = newHeadIndex;
    }

    first(predicate?: (item: T) => boolean): T | undefined {
        if (this.items.length === 0) {
            return undefined;
        }
        else if (!predicate) {
            return this.items[this.headIndex];
        }

        for (let item of this) {
            if (predicate(item)) {
                return item;
            }
        }

        return undefined;
    }
}

function test() {
    const list = new RecencyList(["a", "b", "c", "d", "e"]);

    shouldBe("a", "b", "c", "d", "e");

    list.setHead("c");
    shouldBe("c", "a", "b", "d", "e");

    list.setHead("c");
    shouldBe("c", "a", "b", "d", "e");

    list.setHead("e");
    shouldBe("e", "c", "a", "b", "d");

    list.setHead("b");
    shouldBe("b", "e", "c", "a", "d");

    function shouldBe(...expected: Array<string>) {
        const current = [...list];
        console.log(current);

        for (let i = 0; i < expected.length; i++) {
            if (current[i] !== expected[i]) {
                throw new Error("Doesn't match");
            }
        }
    }
}