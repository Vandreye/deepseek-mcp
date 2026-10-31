import { spawn, execFile } from "node:child_process";

export interface ShellResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 200_000;
const HIDDEN_ENV = /^(DEEPSEEK_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY)$/i;

/** Run a command line in `cwd` through the system shell, capturing stdout+stderr. */
export function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !HIDDEN_ENV.test(k)));
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const onData = (d: Buffer) => {
      output += d.toString("utf8");
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: output + `\n${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output, timedOut });
    });
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
}
