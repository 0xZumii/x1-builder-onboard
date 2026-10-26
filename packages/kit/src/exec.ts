import { execFile } from "node:child_process";

export interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  command: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Quotes one argument for cmd.exe, which is the only shell Windows guarantees. */
function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
}

/**
 * Runs a CLI tool and never throws. Toolchain failures are data, not exceptions,
 * because half of this package's job is explaining them to the user.
 */
export async function run(command: string, args: string[] = [], options: RunOptions = {}): Promise<RunResult> {
  const label = [command, ...args].join(" ");

  const execOptions = {
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeout: options.timeoutMs ?? 300_000,
    maxBuffer: 32 * 1024 * 1024,
  };

  try {
    // Passing args with `shell: true` is deprecated (DEP0190) because Node does
    // not escape them. Build the cmd.exe invocation ourselves instead.
    const isWindows = process.platform === "win32";
    const child = isWindows
      ? execFile(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", `"${[command, ...args].map(quoteForCmd).join(" ")}"`],
          { ...execOptions, windowsVerbatimArguments: true },
        )
      : execFile(command, args, execOptions);

    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      let out = "";
      let err = "";
      child.stdout?.on("data", (chunk) => (out += chunk));
      child.stderr?.on("data", (chunk) => (err += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve({ stdout: out, stderr: err });
        else reject(Object.assign(new Error(err || `exited with code ${code}`), { code, stdout: out, stderr: err }));
      });
    });

    return { ok: true, code: 0, stdout, stderr, command: label };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? String(error),
      command: label,
    };
  }
}

/** Returns the first line of `<tool> --version`, or null when it is not installed. */
export async function toolVersion(command: string, args: string[] = ["--version"]): Promise<string | null> {
  const result = await run(command, args, { timeoutMs: 20_000 });
  if (!result.ok) return null;
  const output = (result.stdout || result.stderr).trim();
  if (!output) return null;
  return output.split(/\r?\n/)[0] ?? null;
}
