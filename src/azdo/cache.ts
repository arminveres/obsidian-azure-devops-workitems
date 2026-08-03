/**
 * Small TTL cache with in-flight request de-duplication, so that repeatedly
 * rendering the same work item in a note results in a single network call.
 */
export class TtlCache<T> {
	private entries = new Map<string, { value: T; storedAt: number }>();
	private inFlight = new Map<string, Promise<T>>();
	/**
	 * Bumped by {@link clear}. Responses that were already in flight when the cache
	 * was cleared must not repopulate it — their data may belong to a stale
	 * organization or project.
	 */
	private generation = 0;

	constructor(
		private ttlMs: number,
		private maxEntries = 2000,
	) {}

	setTtl(ttlMs: number): void {
		this.ttlMs = ttlMs;
	}

	get(key: string): T | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.storedAt + this.ttlMs < Date.now()) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.value;
	}

	/** Returns a cached value even when stale — useful for optimistic rendering. */
	peek(key: string): T | undefined {
		return this.entries.get(key)?.value;
	}

	set(key: string, value: T): void {
		this.entries.delete(key);
		this.entries.set(key, { value, storedAt: Date.now() });
		if (this.entries.size > this.maxEntries) this.prune();
	}

	delete(key: string): void {
		this.entries.delete(key);
		this.inFlight.delete(key);
	}

	clear(): void {
		this.generation++;
		this.entries.clear();
		this.inFlight.clear();
	}

	/** Current generation, for callers that cache results outside {@link resolve}. */
	get currentGeneration(): number {
		return this.generation;
	}

	/** Store a value only if the cache has not been cleared since `generation`. */
	setIfCurrent(key: string, value: T, generation: number): void {
		if (generation === this.generation) this.set(key, value);
	}

	/** Resolve from cache, otherwise run `loader`, sharing concurrent calls. */
	async resolve(key: string, loader: () => Promise<T>): Promise<T> {
		const cached = this.get(key);
		if (cached !== undefined) return cached;

		const pending = this.inFlight.get(key);
		if (pending) return pending;

		const generation = this.generation;
		const request = loader()
			.then((value) => {
				this.setIfCurrent(key, value, generation);
				return value;
			})
			.finally(() => {
				// Only drop our own entry: a newer request may already have replaced it.
				if (this.inFlight.get(key) === request) this.inFlight.delete(key);
			});

		this.inFlight.set(key, request);
		return request;
	}

	/** Drop expired entries, then the oldest ones if still over budget. */
	private prune(): void {
		const cutoff = Date.now() - this.ttlMs;
		for (const [key, entry] of this.entries) {
			if (entry.storedAt < cutoff) this.entries.delete(key);
		}
		// Map iterates in insertion order and `set` re-inserts, so this drops the
		// least recently written entries first.
		let excess = this.entries.size - this.maxEntries;
		if (excess <= 0) return;
		for (const key of this.entries.keys()) {
			this.entries.delete(key);
			if (--excess <= 0) break;
		}
	}
}
