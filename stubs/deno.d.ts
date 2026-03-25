// stubs/deno.d.ts — Deno global stubs so tsc can type-check without deno types

declare namespace Deno {
  interface Conn {
    read(buf: Uint8Array): Promise<number | null>;
    write(buf: Uint8Array): Promise<number>;
    close(): void;
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
  }
  interface Listener extends AsyncIterable<Conn> {
    accept(): Promise<Conn>;
    close(): void;
  }
  interface FsFile {
    writeSync(buf: Uint8Array): number;
    close(): void;
  }
  interface HttpServer {
    shutdown(): Promise<void>;
  }
  interface StatResult { isFile: boolean; isDirectory: boolean; }
  type Signal = "SIGINT" | "SIGTERM" | "SIGHUP";

  function listen(opts: { hostname: string; port: number }): Listener;
  function connect(opts: { hostname: string; port: number }): Promise<Conn>;
  function serve(
    opts: { port: number; hostname: string; onListen?: (addr: unknown) => void },
    handler: (req: Request) => Response | Promise<Response>
  ): HttpServer;
  function readTextFileSync(path: string): string;
  function writeTextFileSync(path: string, content: string): void;
  function writeTextFile(path: string, content: string): Promise<void>;
  function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  function openSync(path: string, opts: { append?: boolean; create?: boolean; write?: boolean; read?: boolean }): FsFile;
  function makeTempFile(opts?: { suffix?: string; prefix?: string }): Promise<string>;
  function remove(path: string): Promise<void>;
  function statSync(path: string): StatResult;
  function addSignalListener(signal: Signal, handler: () => void): void;
  function exit(code?: number): never;

  const env: {
    get(key: string): string | undefined;
    set(key: string, val: string): void;
  };
  const args: string[];
}

declare function atob(data: string): string;
declare function btoa(data: string): string;
