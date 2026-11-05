// Declarations of collection-store.ts: what this file exports, their arguments and what they return.
// import type { CmsFilter, CmsItem, CmsSort } from "./cms-types.js";
// export interface CollectionQuery {
//     collectionId?: string;
//     filters?: CmsFilter[];
//     sort?: CmsSort[];
//     limit?: number;
//     include?: string[];
// }
// export interface CollectionStoreOptions extends CollectionQuery {
//     collectionId: string;
//     initialItems?: CmsItem[];
//     initialHasNext?: boolean;
//     withTotal?: boolean;
//     initialTotal?: number | null;
// }
// export interface CollectionState {
//     items: CmsItem[] | null;
//     hasNext: boolean;
//     hasPrev: boolean;
//     page: number;
//     total: number | null;
//     pageCount: number | null;
//     loading: boolean;
//     fetching: boolean;
//     loadingMore: boolean;
//     error: string | null;
// }
// export interface CollectionStore {
//     getState(): CollectionState;
//     subscribe(listener: (state: CollectionState) => void): () => void;
//     start(): void;
//     stop(): void;
//     setQuery(query: CollectionQuery): void;
//     loadMore(): Promise<void>;
//     goToPage(n: number): void;
//     refresh(): void;
//     retry(): void;
// }
// export declare function createCollectionStore(options: CollectionStoreOptions): CollectionStore;
// One collection as list state, framework-free — the logic behind useCollection, usable from React
// (useCollection wraps it with useSyncExternalStore), from a static page or Vue/Svelte (subscribe
// and render), or as the specification for a port. Same shape as the storefront stores: state,
// actions, subscribe/getState, emit after every change.
//
// The query (collection, filters, sort, page size, includes) is identified BY VALUE; a changed
// query refetches from the first page, a late response from a superseded query is dropped.
// Stale-while-refetch: once items are on screen they STAY there while a new query, page, or
// refresh runs — `fetching` flips instead of `items` going null; only the very first load shows
// skeletons (`loading`). Two ways to page, both at the source: loadMore() appends the next page
// (skip = items shown so far); goToPage(n) replaces the list with page n (0-based; `hasPrev`,
// `page`, and — with `withTotal` — `total`/`pageCount` drive a numbered pager). refresh() re-reads
// what is on screen after a write.
//
// SSR-friendly: seed with `initialItems` from the SAME query and no client fetch happens for the
// first page. One store per mounted listing (a page can hold two collections): createCollectionStore(),
// not a singleton.
import { queryItems } from "./items.js";
const queryKey = (q) => 
// Dates in filters serialize to ISO, so this is stable.
JSON.stringify([q.collectionId, q.filters ?? null, q.sort ?? null, q.limit, q.include ?? null]);
export function createCollectionStore(options) {
    let collectionId = options.collectionId;
    let filters = options.filters;
    let sort = options.sort;
    let limit = options.limit ?? 20;
    let include = options.include;
    const withTotal = options.withTotal ?? false;
    const key = () => queryKey({ collectionId, filters, sort, limit, include });
    let items = options.initialItems ?? null;
    let hasNext = options.initialHasNext ?? (options.initialItems ? options.initialItems.length >= limit : false);
    let page = 0;
    let total = withTotal ? (options.initialTotal ?? null) : null;
    let loadingMore = false;
    let fetching = false;
    let error = null;
    // The query the latest request targets (null = nothing requested yet).
    let pageKey = options.initialItems ? key() : null;
    let inflight = false;
    let started = false;
    let generation = 0;
    const listeners = new Set();
    let snapshot = null;
    const emit = () => { snapshot = null; for (const fn of listeners)
        fn(); };
    function getState() {
        if (snapshot)
            return snapshot;
        snapshot = {
            items,
            hasNext,
            hasPrev: page > 0,
            page,
            total,
            pageCount: total === null ? null : Math.ceil(total / limit),
            loading: items === null,
            fetching,
            loadingMore,
            error,
        };
        return snapshot;
    }
    /**
     * Load page `nextPage` of the current query (`window` items wide — the page size, or the whole
     * shown list on a refresh). Items already on screen stay while it runs (fetching); the first load
     * has none, so it shows skeletons (loading).
     */
    function load(nextPage, window = limit) {
        if (!started)
            return;
        const k = key();
        const id = ++generation;
        pageKey = k;
        inflight = true;
        error = null;
        loadingMore = false;
        fetching = items !== null; // something is on screen → it stays, dimmed; nothing yet → skeletons (loading)
        emit();
        queryItems(collectionId, { filters, sort, limit: window, skip: nextPage * limit, include, withTotal })
            .then((res) => {
            if (generation !== id)
                return; // superseded — drop it
            items = res.items;
            hasNext = res.hasNext;
            page = nextPage;
            if (withTotal)
                total = res.total;
            inflight = false;
            fetching = false;
            emit();
        })
            .catch((e) => {
            if (generation !== id)
                return;
            // A first load that fails shows the error with an empty list; a refetch keeps what was on screen.
            if (items === null) {
                items = [];
                hasNext = false;
            }
            inflight = false;
            fetching = false;
            error = e instanceof Error ? e.message : String(e);
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
                console.error("collection-store listener failed", e);
            } };
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        start() {
            if (started)
                return;
            started = true;
            // The SSR seed answered this exact query — no fetch; a dropped first load reruns.
            if (pageKey !== key() || (items === null && !inflight))
                load(0);
        },
        stop() {
            started = false;
            generation++;
            inflight = false;
            fetching = false;
        },
        setQuery(q) {
            if (q.collectionId !== undefined)
                collectionId = q.collectionId;
            filters = q.filters;
            sort = q.sort;
            include = q.include;
            if (q.limit !== undefined)
                limit = q.limit;
            if (key() === pageKey)
                return; // same values — same page
            if (started)
                load(0);
        },
        async loadMore() {
            const current = items;
            if (!current || loadingMore || inflight)
                return;
            const id = generation;
            loadingMore = true;
            emit();
            try {
                const res = await queryItems(collectionId, { filters, sort, limit, include, withTotal, skip: page * limit + current.length });
                if (generation !== id)
                    return;
                items = [...(items ?? []), ...res.items];
                hasNext = res.hasNext;
                if (withTotal)
                    total = res.total;
            }
            catch (e) {
                if (generation !== id)
                    return;
                error = e instanceof Error ? e.message : String(e);
            }
            finally {
                if (generation === id) {
                    loadingMore = false;
                    emit();
                }
            }
        },
        goToPage(n) {
            if (n < 0)
                return;
            // Already showing exactly that page of this query (appended pages collapse back to one).
            const shown = n === page && key() === pageKey && items !== null && !inflight && items.length <= limit;
            if (shown)
                return;
            load(n);
        },
        refresh() {
            // The whole shown window (several appended pages read as one), or the page size before any answer.
            load(page, items && items.length > limit ? items.length : limit);
        },
        retry() {
            pageKey = null;
            items = null;
            page = 0;
            load(0);
        },
    };
}
