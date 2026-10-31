import { spawn, execFile } from "node:child_process";

export interface ShellResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 200_000;
const HIDDEN_ENV = /^(DEEPSEEK_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY)$/i;

/**
 * cmd.exe reads "service/.venv/Scripts/python" as the program "service" with a /.venv switch.
 * On Windows, turn the slashes in the program path (the first word) into backslashes.
 */
export function fixWindowsProgram(command: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return command;
  const m = /^(\s*)("([^"]*)"|[^\s"']+)/.exec(command);
  if (!m) return command;
  const word = m[3] ?? m[2];
  if (!word.includes("/") || /^[a-z][a-z0-9+.-]*:\/\//i.test(word)) return command;
  const fixed = word.replace(/\//g, "\\");
  const out = m[3] !== undefined ? `"${fixed}"` : fixed;
  return m[1] + out + command.slice(m[0].length);
}

/** Run a command line in `cwd` through the system shell, capturing stdout+stderr. */
export function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
  command = fixWindowsProgram(command);
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !HIDDEN_ENV.test(k)));
    // On Unix the shell gets its own process group, so a timeout can kill its children too.
    const child = spawn(command, {
      cwd, shell: true, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
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
      process.kill(-pid, "SIGKILL"); // the whole group
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
  }
}
