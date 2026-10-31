export type ParseResult = { ok: true; argv: string[] } | { ok: false; reason: string };

/**
 * Characters that let a command chain, redirect or expand into something else.
 * Commands containing them never run automatically.
 */
const FORBIDDEN = /[&|;<>`$^%!\r\n(){}]/;

/** Split a command line into words. Supports '...' and "..." quoting, nothing else. */
export function parseCommand(input: string): ParseResult {
  const s = (input ?? "").trim();
  if (!s) return { ok: false, reason: "Empty command." };
  if (FORBIDDEN.test(s)) {
    return { ok: false, reason: "Shell operators (& | ; < > $ ` % ^ ! ( ) { }) are not allowed in run_command." };
  }
  const argv: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let inWord = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) argv.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (quote) return { ok: false, reason: "Unclosed quote." };
  if (inWord) argv.push(cur);
  return { ok: true, argv };
}

type Matcher = string | RegExp;

const SCRIPT = /^(test|build|lint|typecheck|type-check|check|compile)(:[\w.-]+)?$/;

/** Command prefixes DeepSeek may run without asking: tests, builds, linters, read-only git. */
const ALLOW: Matcher[][] = [
  ["npm", "test"], ["npm", "t"], ["npm", "run", SCRIPT], ["npm", "ls"], ["npm", "outdated"],
  ["pnpm", "test"], ["pnpm", "run", SCRIPT], ["yarn", "test"], ["yarn", "run", SCRIPT],
  ["npx", "tsc"], ["npx", "vitest"], ["npx", "jest"], ["npx", "eslint"], ["npx", "prettier", /^(--check|-c)$/],
  ["node", "--version"], ["python", "--version"], ["py", "--version"],
  ["python", "-m", "pytest"], ["python", "-m", "unittest"], ["python", "-m", "mypy"], ["python", "-m", "ruff", "check"],
  ["py", "-m", "pytest"], ["pytest"], ["mypy"], ["ruff", "check"],
  ["cargo", /^(build|test|check|clippy)$/], ["go", /^(build|test|vet)$/], ["dotnet", /^(build|test)$/],
  ["git", /^(status|diff|log|show|blame|ls-files|rev-parse)$/],
];

const GIT_BRANCH_FLAGS = new Set(["-a", "-r", "-v", "-vv", "--list", "--show-current"]);

const DELETE_PROGRAMS = new Set([
  "rm", "rmdir", "rd", "del", "erase", "remove-item", "ri", "unlink", "shred", "rimraf", "trash",
]);

function norm(word: string): string {
  // "C:\Tools\RM.EXE" -> "rm"
  return (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

/** True if the command deletes files (these always need approval). */
export function isDeletion(argv: string[]): boolean {
  if (argv.length === 0) return false;
  const words = argv.map(norm);
  if (DELETE_PROGRAMS.has(words[0])) return true;
  if (words[0] === "git" && (words[1] === "clean" || words[1] === "rm")) return true;
  if (words.includes("rimraf") || words.includes("-delete") || words.includes("remove-item")) return true;
  if (words[0] === "find" && words.some((w) => w === "-exec" || w === "-delete")) return true;
  return false;
}

const WRITE_FLAGS = new Set(["--write", "-w", "--clean", "-u", "--update", "--updateSnapshot", "--unsafe-fixes"]);

/** Flags that make a test/lint/build tool change source files. */
function writesFiles(arg: string): boolean {
  const flag = arg.split("=")[0];
  return WRITE_FLAGS.has(flag) || (flag.startsWith("--fix") && flag !== "--fix-dry-run");
}

function matches(argv: string[], prefix: Matcher[]): boolean {
  if (argv.length < prefix.length) return false;
  return prefix.every((m, i) => {
    const w = i === 0 ? norm(argv[i]) : argv[i];
    return typeof m === "string" ? w === m : m.test(w);
  });
}

/** "allow" = run now; "approve" = must be approved by the user. */
export function classifyCommand(argv: string[], extraAllow: string[][] = []): "allow" | "approve" {
  if (argv.length === 0 || isDeletion(argv)) return "approve";
  // git can write files with --output; never auto-run that.
  if (norm(argv[0]) === "git" && argv.some((a) => a.startsWith("--output") || a.startsWith("--ext-diff"))) return "approve";
  if (norm(argv[0]) === "git" && argv[1] === "branch") {
    return argv.slice(2).every((a) => GIT_BRANCH_FLAGS.has(a)) ? "allow" : "approve";
  }
  // Allowed tools that rewrite or delete files with a flag (eslint --fix, prettier --write, vitest -u, …).
  if (argv.slice(1).some(writesFiles)) return "approve";
  if (["eslint", "npx"].includes(norm(argv[0])) && argv.some((a) => a.startsWith("-o") || a.startsWith("--output-file"))) return "approve";
  if (ALLOW.some((p) => matches(argv, p))) return "allow";
  if (extraAllow.some((p) => matches(argv, p))) return "allow";
  return "approve";
}

/** Rebuild a safe command string from parsed words, quoting where needed. */
export function toCommandString(argv: string[]): string {
  // $ and ` are refused by parseCommand, so \" is a plain quote for both sh and Windows programs.
  // On Windows, cmd.exe passes \" through untouched (also via npm.cmd's %*), and the program's
  // argv parser reads it as a quote; cmd's own quote tracking only matters for & | < > etc., which are refused.
  // Backslashes before a quote (or the closing quote) are doubled so they stay literal.
  const quote = (a: string) => `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  return argv.map((a) => (a === "" || /[\s"']/.test(a) ? quote(a) : a)).join(" ");
}

export function describeAllowlist(): string {
  return "tests/builds/linters (npm test, npm run build|lint|typecheck|test:*, npx tsc|vitest|jest|eslint, pytest, cargo/go/dotnet build|test), read-only git (status, diff, log, show, blame, ls-files, rev-parse, branch --list)";
}
