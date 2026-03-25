// stubs/sqlite.d.ts — minimal @db/sqlite stubs for tsc
export class Database {
  constructor(path: string);
  exec(sql: string, ...params: unknown[]): void;
  prepare(sql: string): PreparedStatement;
  close(): void;
}
export interface PreparedStatement {
  value<T extends unknown[]>(...params: unknown[]): T | undefined;
  values<T extends unknown[]>(...params: unknown[]): T[];
  finalize(): void;
}
