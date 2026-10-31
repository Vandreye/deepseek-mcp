import { describe, expect, it } from "vitest";
import { classifyCommand, isDeletion, parseCommand } from "../src/safety/commands.js";

const argv = (s: string) => {
  const r = parseCommand(s);
  if (!r.ok) throw new Error(r.reason);
  return r.argv;
};

describe("command parsing", () => {
  it("splits words and quotes", () => {
    expect(argv(`npx vitest run "tests/a b.test.ts"`)).toEqual(["npx", "vitest", "run", "tests/a b.test.ts"]);
    expect(argv(`git log --oneline -5`)).toEqual(["git", "log", "--oneline", "-5"]);
  });

  it("rejects chaining, pipes, redirects and expansion", () => {
    for (const bad of ["npm test && rm -rf /", "git status | sh", "npm test; del x", "echo $HOME", "git log > out.txt", "type %USERPROFILE%", "npm test `x`", `npm test "unclosed`]) {
      expect(parseCommand(bad).ok, bad).toBe(false);
    }
  });
});

describe("command allowlist", () => {
  it("allows tests, builds and read-only git", () => {
    for (const ok of ["npm test", "npm run build", "npm run test:unit", "npx tsc --noEmit", "pytest -q", "python -m pytest", "git status", "git diff --stat", "git branch -a", "cargo test", "C:\\nodejs\\npm.cmd test"]) {
      expect(classifyCommand(argv(ok)), ok).toBe("allow");
    }
  });

  it("requires approval for everything else", () => {
    for (const no of ["node script.js", "npm install left-pad", "npm run clean", "git push", "git checkout main", "git branch -D main", "git diff --output=x.txt", "curl http://x", "powershell -c ls", "python x.py"]) {
      expect(classifyCommand(argv(no)), no).toBe("approve");
    }
  });

  it("always flags deletions", () => {
    for (const del of ["rm -rf build", "del /q x.txt", "Remove-Item x", "rmdir out", "git clean -fd", "git rm a.ts", "npx rimraf dist", "find . -delete"]) {
      expect(isDeletion(argv(del)), del).toBe(true);
      expect(classifyCommand(argv(del), [argv(del)]), del).toBe("approve"); // even if user-allowlisted
    }
  });

  it("supports extra user-allowed prefixes", () => {
    expect(classifyCommand(argv("make test"), [["make", "test"]])).toBe("allow");
    expect(classifyCommand(argv("make install"), [["make", "test"]])).toBe("approve");
  });
});
