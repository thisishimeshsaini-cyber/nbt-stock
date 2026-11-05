// Declarations of item-store.ts: what this file exports, their arguments and what they return.
// import type { CmsItem } from "./cms-types.js";
// export interface ItemRef {
//     id?: string;
//     by?: {
//         field: string;
//         value: string | number;
//     };
// }
// export interface ItemStoreOptions {
//     collectionId: string;
//     ref: ItemRef;
//     initialItem?: CmsItem;
//     include?: string[];
// }
// export interface ItemState {
//     item: CmsItem | null;
//     notFound: boolean;
//     error: string | null;
//     loading: boolean;
// }
// export interface ItemStore {
//     getState(): ItemState;
//     subscribe(listener: (state: ItemState) => void): () => void;
//     start(): void;
//     stop(): void;
//     retry(): void;
// }
// export declare function createItemStore({ collectionId, ref, initialItem, include }: ItemStoreOptions): ItemStore;
// One item as a framework-free store — the logic behind useItem: by `_id` or by a field match
// (slug routing), usable from React (useItem wraps it), from a static page's item view, from
// Vue/Svelte, or as the specification for a port.
//
// SSR-friendly: pass the server-fetched item as `initialItem` and start() fetches nothing.
// One store per item surface: createItemStore(), not a singleton.
import { getItemBy, getItemById } from "./items.js";
export function createItemStore({ collectionId, ref, initialItem, include }) {
    let item = initialItem ?? null;
    let notFound = false;
    let error = null;
    let loading = !initialItem;
    let started = false;
    let generation = 0;
    const listeners = new Set();
    let snapshot = null;
    const emit = () => { snapshot = null; for (const fn of listeners)
        fn(); };
    function getState() {
        if (snapshot)
            return snapshot;
        snapshot = { item, notFound, error, loading };
        return snapshot;
    }
    function load() {
        const id = ++generation;
        loading = true;
        error = null;
        emit();
        const fetching = ref.id
            ? getItemById(collectionId, ref.id, { include })
            : ref.by
                ? getItemBy(collectionId, ref.by.field, ref.by.value, { include })
                : Promise.reject(new Error("useItem: pass ref.id or ref.by"));
        fetching
            .then((found) => {
            if (generation !== id || !started)
                return;
            item = found;
            notFound = found === null;
            loading = false;
            emit();
        })
            .catch((e) => {
            if (generation !== id || !started)
                return;
            error = e instanceof Error ? e.message : String(e);
            loading = false;
            emit();
        });
    }
    return {
        getState,
        subscribe(fn) {
            const listener = () => { try {
                fn(getState());
            }
            catch (e) {
                console.error("item-store listener failed", e);
            } };
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        start() {
            if (started)
                return;
            started = true;
            if (initialItem)
                return;
            load();
        },
        stop() { started = false; generation++; },
        retry() { if (started)
            load(); },
    };
}
