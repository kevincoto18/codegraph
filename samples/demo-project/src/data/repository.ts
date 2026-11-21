/** Stored user record. */
export interface UserRecord {
  readonly email: string;
}

/** Persists a record. */
export function save(record: UserRecord): void {
  connect();
  void record;
}

/** Opens the (pretend) database connection. */
function connect(): void {}
