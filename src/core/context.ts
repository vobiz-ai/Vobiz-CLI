/**
 * Ctx is the one object every command receives. It owns the global flags (filled by cli.ts before each action),
 * the config store, the streams, prompts, and lazily created credentials and client: a command that never makes
 * a request never needs credentials, and `vobiz help` works without a login.
 *
 * Everything with side effects (fetch, prompts, stdin, opening a browser, clock) is injectable so command tests
 * run against fakes; see test/helpers.ts `makeCtx`.
 */
import { spawn } from "node:child_process";
import { ConfigStore } from "./config.js";
import { resolveCredentials, type ResolvedCredentials } from "./credentials.js";
import { VobizClient, type LogLevel } from "./client.js";
import { Printer, type OutputMode, type Stream } from "./output.js";

export interface GlobalFlags {
  profile?: string;
  authId?: string;
  authToken?: string;
  output?: OutputMode;
  json?: boolean;
  fields?: string[];
  /** --query path applied to printed data after --fields (see parseQuery in output.ts). */
  query?: string;
  quiet?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  wait?: boolean;
  baseUrl?: string;
  smsBaseUrl?: string;
  /** Per-request timeout in seconds. */
  timeout: number;
  color: boolean;
  verbose?: boolean;
  debug?: boolean;
  /** Only honoured together with --debug. */
  showSecrets?: boolean;
  updateCheck: boolean;
}

export interface Prompts {
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  input(message: string): Promise<string>;
  /** Hidden input (tokens). */
  password(message: string): Promise<string>;
}

export interface StdinLike {
  isTTY?: boolean;
  /** Reads all of stdin as text. */
  read(): Promise<string>;
}

export interface CtxOptions {
  env?: NodeJS.ProcessEnv;
  store?: ConfigStore;
  stdout?: Stream;
  stderr?: Stream;
  stdin?: StdinLike;
  fetch?: typeof fetch;
  prompts?: Prompts;
  now?: () => Date;
  /** Opens a URL in the user's browser (login --browser). */
  openUrl?: (url: string) => Promise<void>;
  flags?: Partial<GlobalFlags>;
}

export const defaultFlags = (): GlobalFlags => ({ timeout: 30, color: true, updateCheck: true });

export class Ctx {
  readonly env: NodeJS.ProcessEnv;
  readonly store: ConfigStore;
  readonly stdout: Stream;
  readonly stderr: Stream;
  readonly stdin: StdinLike;
  readonly fetch: typeof fetch;
  readonly prompts: Prompts;
  readonly now: () => Date;
  readonly openUrl: (url: string) => Promise<void>;
  /** Filled from the parsed command line by cli.ts before every action. */
  flags: GlobalFlags;
  /** Set by a command that wants a non-zero exit without throwing (e.g. `doctor` with failed checks). */
  exitCode = 0;
  readonly out: Printer;
  private _creds?: ResolvedCredentials;
  private _client?: VobizClient;

  constructor(o: CtxOptions = {}) {
    this.env = o.env ?? process.env;
    this.store = o.store ?? new ConfigStore(undefined);
    this.stdout = o.stdout ?? process.stdout;
    this.stderr = o.stderr ?? process.stderr;
    this.stdin = o.stdin ?? { isTTY: process.stdin.isTTY, read: readProcessStdin };
    this.fetch = o.fetch ?? globalThis.fetch;
    this.prompts = o.prompts ?? inquirerPrompts();
    this.now = o.now ?? (() => new Date());
    this.openUrl = o.openUrl ?? ((url: string) => openUrlGuarded(url, { env: this.env, stdout: this.stdout, stderr: this.stderr }));
    this.flags = { ...defaultFlags(), ...o.flags };
    const ctx = this;
    this.out = new Printer({
      get flags() {
        return ctx.flags;
      },
      env: this.env,
      stdout: this.stdout,
      stderr: this.stderr,
      get defaultOutput() {
        try {
          return ctx.store.settings().output;
        } catch {
          return undefined;
        }
      },
    });
  }

  get isTTY(): { stdin: boolean; stdout: boolean; stderr: boolean } {
    return { stdin: !!this.stdin.isTTY, stdout: !!this.stdout.isTTY, stderr: !!this.stderr.isTTY };
  }

  /** Resolved credentials (flags > env > profile). Throws missing_credentials on first use when there are none. */
  get creds(): ResolvedCredentials {
    return (this._creds ??= resolveCredentials(this.flags, this.store, this.env));
  }

  /** Client bound to `creds`, the global timeout and --dry-run. */
  get client(): VobizClient {
    return (this._client ??= this.makeClient(() => this.creds));
  }

  /** A client for explicit credentials (login verifies new credentials before saving them). */
  makeClient(creds: ResolvedCredentials | (() => ResolvedCredentials)): VobizClient {
    return new VobizClient({
      creds,
      fetch: this.fetch,
      timeoutMs: this.flags.timeout * 1000,
      log: (level, msg) => this.log(level, msg),
      dryRun: () => !!this.flags.dryRun,
    });
  }

  /** Forget cached credentials/client (after login or profile switches). */
  resetAuth(): void {
    this._creds = undefined;
    this._client = undefined;
  }

  /** Diagnostics to stderr: `verbose` needs --verbose or --debug, `debug` needs --debug or VOBIZ_LOG=debug. */
  log(level: LogLevel, message: string): void {
    const debug = !!this.flags.debug || this.env.VOBIZ_LOG === "debug";
    if (level === "debug" && !debug) return;
    if (level === "verbose" && !(this.flags.verbose || debug)) return;
    if (level === "info" && this.flags.quiet) return;
    const prefix = level === "warn" ? "warning: " : level === "info" ? "" : `[${level}] `;
    this.stderr.write(prefix + message + "\n");
  }
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}

/** @inquirer/prompts, rendered on stderr so stdout stays data-only. Loaded lazily (it is not needed in CI). */
function inquirerPrompts(): Prompts {
  const ctx = { output: process.stderr, clearPromptOnDone: false };
  return {
    async confirm(message, defaultValue = false) {
      const { confirm } = await import("@inquirer/prompts");
      return confirm({ message, default: defaultValue }, ctx);
    },
    async input(message) {
      const { input } = await import("@inquirer/prompts");
      return input({ message, validate: (v) => (v.trim() ? true : "Required") }, ctx);
    },
    async password(message) {
      const { password } = await import("@inquirer/prompts");
      return password({ message, mask: "•", validate: (v) => (v.trim() ? true : "Required") }, ctx);
    },
  };
}

type SpawnFn = typeof spawn;

/** True when launching a browser would not surprise someone: an interactive terminal, not CI, not a test runner, no opt-out. */
export function browserAllowed(env: NodeJS.ProcessEnv = process.env, isTTY: boolean = Boolean(process.stdout.isTTY)): boolean {
  return isTTY && !env.CI && !env.VOBIZ_NO_BROWSER && env.NODE_ENV !== "test" && !env.VITEST;
}

/**
 * The default `openUrl`: spawns the platform opener only for an interactive session. With VOBIZ_NO_BROWSER or CI
 * set, under a test runner, or when stdout is not a terminal (pipes, agents), it prints "Open: <url>" to stderr instead.
 */
export async function openUrlGuarded(
  url: string,
  o: { env: NodeJS.ProcessEnv; stdout: Stream; stderr: Stream },
  spawnFn: SpawnFn = spawn,
): Promise<void> {
  if (!browserAllowed(o.env, Boolean(o.stdout.isTTY))) {
    o.stderr.write(`Open: ${url}
`);
    return;
  }
  await openInBrowser(url, spawnFn);
}

async function openInBrowser(url: string, spawnFn: SpawnFn = spawn): Promise<void> {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  await new Promise<void>((resolve) => {
    try {
      const child = spawnFn(cmd, args as string[], { stdio: "ignore", detached: true });
      child.on("error", () => resolve());
      child.unref();
      resolve();
    } catch {
      resolve();
    }
  });
}
