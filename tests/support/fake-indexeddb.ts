/**
 * IndexedDB for tests: the part of it src/lib/escrow/client/card-store.ts
 * uses, with the browser's semantics where they matter. Test-only; never
 * referenced from src/.
 *
 *   - open(name, version): upgradeneeded on first open, then success, async.
 *   - transaction(store, mode).objectStore(store): get, put, add, delete,
 *     getAllKeys, each an async request; the transaction completes after its
 *     last request, and a failed request aborts it and undoes its writes.
 *   - `add` on a key that exists fails with ConstraintError, as the browser's.
 *   - Values are stored by structured clone, so a CryptoKey is kept as the
 *     browser keeps it: a handle, non-extractable still, and no caller can
 *     change a stored value by holding on to it.
 *
 * One factory is one browser profile: two opens of the same name share data,
 * which is how a test reloads the page. `blocked` makes every open fail, as a
 * private window or blocked site data does.
 */

type Listener = ((ev: unknown) => void) | null

class FakeRequest<T> {
  result: T | undefined = undefined
  error: DOMException | null = null
  onsuccess: Listener = null
  onerror: Listener = null
  readyState: 'pending' | 'done' = 'pending'

  succeed(value: T): void {
    this.result = value
    this.readyState = 'done'
    this.onsuccess?.({ target: this })
  }

  fail(error: DOMException): void {
    this.error = error
    this.readyState = 'done'
    this.onerror?.({ target: this })
  }
}

class FakeOpenRequest extends FakeRequest<FakeDatabase> {
  onupgradeneeded: Listener = null
  onblocked: Listener = null
}

class FakeStoreNames {
  constructor(readonly names: Set<string>) {}
  contains(name: string): boolean {
    return this.names.has(name)
  }
  get length(): number {
    return this.names.size
  }
}

type Data = Map<string, Map<IDBValidKey, unknown>>

class FakeTransaction {
  oncomplete: Listener = null
  onerror: Listener = null
  onabort: Listener = null
  error: DOMException | null = null
  private pending = 0
  private finished = false
  private readonly undo: Array<() => void> = []

  constructor(
    private readonly data: Data,
    private readonly names: readonly string[],
    readonly mode: IDBTransactionMode,
  ) {}

  objectStore(name: string): FakeObjectStore {
    if (!this.names.includes(name) || !this.data.has(name)) throw new DOMException(`No objectStore named ${name}`, 'NotFoundError')
    return new FakeObjectStore(this, this.data.get(name) as Map<IDBValidKey, unknown>)
  }

  /** Run one request after the current task, as the browser does. */
  request<T>(work: () => T): FakeRequest<T> {
    if (this.finished) throw new DOMException('The transaction has finished.', 'TransactionInactiveError')
    const req = new FakeRequest<T>()
    this.pending += 1
    setTimeout(() => {
      if (this.finished) return
      try {
        req.succeed(work())
      } catch (err) {
        const e = err instanceof DOMException ? err : new DOMException(String(err), 'UnknownError')
        req.fail(e)
        this.abort(e)
        return
      }
      this.pending -= 1
      if (this.pending === 0) setTimeout(() => this.complete(), 0)
    }, 0)
    return req
  }

  remember(undo: () => void): void {
    this.undo.push(undo)
  }

  private complete(): void {
    if (this.finished || this.pending > 0) return
    this.finished = true
    this.oncomplete?.({ target: this })
  }

  private abort(e: DOMException): void {
    if (this.finished) return
    this.finished = true
    for (const u of this.undo.reverse()) u()
    this.error = e
    this.onerror?.({ target: this })
    this.onabort?.({ target: this })
  }
}

class FakeObjectStore {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly map: Map<IDBValidKey, unknown>,
  ) {}

  private writable(): void {
    if (this.tx.mode !== 'readwrite') throw new DOMException('The transaction is read-only.', 'ReadOnlyError')
  }

  private write(key: IDBValidKey, value: unknown): void {
    const had = this.map.has(key)
    const before = this.map.get(key)
    this.map.set(key, structuredClone(value))
    this.tx.remember(() => (had ? this.map.set(key, before) : this.map.delete(key)))
  }

  get(key: IDBValidKey): FakeRequest<unknown> {
    return this.tx.request(() => (this.map.has(key) ? structuredClone(this.map.get(key)) : undefined))
  }

  put(value: unknown, key: IDBValidKey): FakeRequest<IDBValidKey> {
    this.writable()
    return this.tx.request(() => {
      this.write(key, value)
      return key
    })
  }

  add(value: unknown, key: IDBValidKey): FakeRequest<IDBValidKey> {
    this.writable()
    return this.tx.request(() => {
      if (this.map.has(key)) throw new DOMException('Key already exists in the object store.', 'ConstraintError')
      this.write(key, value)
      return key
    })
  }

  delete(key: IDBValidKey): FakeRequest<undefined> {
    this.writable()
    return this.tx.request(() => {
      if (this.map.has(key)) {
        const before = this.map.get(key)
        this.map.delete(key)
        this.tx.remember(() => this.map.set(key, before))
      }
      return undefined
    })
  }

  getAllKeys(): FakeRequest<IDBValidKey[]> {
    return this.tx.request(() => [...this.map.keys()])
  }
}

class FakeDatabase {
  readonly objectStoreNames: FakeStoreNames
  constructor(
    readonly name: string,
    private readonly data: Data,
  ) {
    this.objectStoreNames = new FakeStoreNames(new Set(data.keys()))
  }

  createObjectStore(name: string): void {
    if (this.data.has(name)) throw new DOMException(`objectStore ${name} exists`, 'ConstraintError')
    this.data.set(name, new Map())
    this.objectStoreNames.names.add(name)
  }

  transaction(names: string | string[], mode: IDBTransactionMode = 'readonly'): FakeTransaction {
    return new FakeTransaction(this.data, Array.isArray(names) ? names : [names], mode)
  }

  close(): void {}
}

export class FakeIndexedDB {
  /** Every database of this "browser profile", by name: object store name, then key, then the stored clone. */
  readonly databases = new Map<string, { version: number; data: Data }>()
  /** Make every open fail, as a private window or blocked site data does. */
  blocked = false

  open(name: string, version = 1): FakeOpenRequest {
    const req = new FakeOpenRequest()
    setTimeout(() => {
      if (this.blocked) {
        req.fail(new DOMException('The user denied permission to access the database.', 'UnknownError'))
        return
      }
      let db = this.databases.get(name)
      const upgrading = db === undefined || db.version < version
      if (db === undefined) {
        db = { version, data: new Map() }
        this.databases.set(name, db)
      }
      db.version = version
      const handle = new FakeDatabase(name, db.data)
      req.result = handle
      if (upgrading) req.onupgradeneeded?.({ target: req, oldVersion: 0, newVersion: version })
      req.succeed(handle)
    }, 0)
    return req
  }

  /** Every stored value, cloned, for a test that looks at what was written. */
  dump(name = 'salvo-pay', store = 'kv'): Map<IDBValidKey, unknown> {
    return new Map([...(this.databases.get(name)?.data.get(store) ?? new Map<IDBValidKey, unknown>())].map(([k, v]) => [k, structuredClone(v)]))
  }

  /** As this factory, typed as the browser's. */
  asFactory(): IDBFactory {
    return this as unknown as IDBFactory
  }
}
