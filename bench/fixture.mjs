// The benchmark's test project: a small plain-JS shop backend with planted bugs.
// Generated fresh for every run, so code tasks never affect each other.
// Uses only node:test, so `npm test` works without installing anything.
import fs from "node:fs";
import path from "node:path";

const FILES = {
  "package.json": JSON.stringify({ name: "bench-shop", version: "1.0.0", type: "module", private: true, scripts: { test: "node --test" } }, null, 2) + "\n",
  "README.md": "# bench-shop\n\nA tiny shop backend: orders, slugs, money formatting, uploads and a legacy admin area.\n",

  // Task: review (4 planted bugs: percent discount, negative qty, empty average, unawaited save)
  "src/orders.js": `import { saveOrder } from "./store.js";

/** Apply a percentage discount, e.g. applyDiscount(200, 10) === 180. */
export function applyDiscount(total, percent) {
  return total - total * percent;
}

/** Parse a quantity typed by a customer. Must be a whole number of at least 1. */
export function parseQty(input) {
  const n = parseInt(input);
  if (Number.isNaN(n)) throw new Error("not a number");
  return n;
}

/** Average order value. */
export function averageTotal(orders) {
  const sum = orders.reduce((s, o) => s + o.total, 0);
  return sum / orders.length;
}

/** Save every order, then report how many were saved. */
export async function saveAll(orders) {
  let saved = 0;
  orders.forEach(async (o) => {
    await saveOrder(o);
    saved++;
  });
  return saved;
}
`,
  "src/store.js": `const db = [];
export async function saveOrder(o) {
  await new Promise((r) => setTimeout(r, 1));
  db.push(o);
}
export function allOrders() {
  return [...db];
}
`,

  // Task: bugfix (slugify keeps trailing dashes and doesn't collapse repeats)
  "src/slug.js": `/** "Hello,  World!" -> "hello-world" */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-");
}
`,
  "tests/slug.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.js";

test("slugify makes clean slugs", () => {
  assert.equal(slugify("Hello,  World!"), "hello-world");
  assert.equal(slugify("  Already-clean  "), "already-clean");
});
`,

  // Task: code (add chunk)
  "src/array.js": `/** Unique values, first occurrence wins. */
export function unique(arr) {
  return [...new Set(arr)];
}
`,
  "tests/array.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { unique } from "../src/array.js";

test("unique", () => {
  assert.deepEqual(unique([1, 2, 1, 3]), [1, 2, 3]);
});
`,

  // Task: tests (untested, correct function)
  "src/money.js": `/** formatMoney(1234.5) === "$1,234.50"; negatives as "-$3.00". Cents are rounded. */
export function formatMoney(amount, symbol = "$") {
  const sign = amount < 0 ? "-" : "";
  const cents = Math.round(Math.abs(amount) * 100);
  const whole = Math.floor(cents / 100).toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
  const frac = String(cents % 100).padStart(2, "0");
  return \`\${sign}\${symbol}\${whole}.\${frac}\`;
}
`,

  // Task: research (where is the upload limit enforced)
  "src/config.js": `export const settings = {
  port: 8080,
  currency: "USD",
};
`,
  "src/upload.js": `import { settings } from "./config.js";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function checkUpload(file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("File too large");
  }
  return { ok: true, currency: settings.currency };
}
`,

  // Task: approval (not on the allowlist, writes a file if it ever runs)
  "scripts/seed.js": `import fs from "node:fs";
fs.writeFileSync("seeded.txt", "seeded 3 orders\\n");
console.log("seeded 3 orders");
`,
};

// Legacy admin area: 14 filler files and 3 planted issues (SQL injection, eval, path traversal).
const LEGACY_ISSUES = {
  "src/legacy/db/users.js": `import { query } from "./conn.js";

export function findUser(name) {
  return query("SELECT * FROM users WHERE name = '" + name + "'");
}
`,
  "src/legacy/admin/calc.js": `/** Admin console: evaluate a pricing formula typed by staff. */
export function runFormula(formula, price) {
  return eval(formula.replace("price", String(price)));
}
`,
  "src/legacy/files/download.js": `import fs from "node:fs";
import path from "node:path";

const ROOT = "/srv/files";

export function readDownload(name) {
  return fs.readFileSync(path.join(ROOT, name));
}
`,
  "src/legacy/db/conn.js": `export function query(sql) {
  return { sql, rows: [] };
}
`,
};

function legacyFiller() {
  const out = {};
  const areas = ["admin", "db", "files", "reports"];
  for (let i = 1; i <= 14; i++) {
    const area = areas[i % areas.length];
    out[`src/legacy/${area}/util${i}.js`] = `/** Legacy helper ${i}. */
export function helper${i}(values) {
  const out = [];
  for (const v of values) {
    if (v == null) continue;
    out.push(String(v).trim());
  }
  return out.join(",");
}

export const LIMIT_${i} = ${i * 10};
`;
  }
  return out;
}

/** Hidden checks, copied in only after DeepSeek has finished. */
export const HIDDEN = {
  slug: `import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.js";
test("hidden slug cases", () => {
  assert.equal(slugify("Hello,  World!"), "hello-world");
  assert.equal(slugify("--A  b--"), "a-b");
  assert.equal(slugify("Rock & Roll!!"), "rock-roll");
  assert.equal(slugify("x"), "x");
});
`,
  chunk: `import { test } from "node:test";
import assert from "node:assert/strict";
import * as arr from "../src/array.js";
test("hidden chunk cases", () => {
  assert.equal(typeof arr.chunk, "function");
  assert.deepEqual(arr.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(arr.chunk([], 3), []);
  assert.deepEqual(arr.chunk([1, 2], 5), [[1, 2]]);
  assert.throws(() => arr.chunk([1], 0));
});
`,
};

/** A broken formatMoney, to check that DeepSeek's new tests actually catch bugs. */
export const BROKEN_MONEY = `export function formatMoney(amount, symbol = "$") {
  return symbol + amount.toFixed(2);
}
`;

export function writeFixture(dir) {
  const all = { ...FILES, ...LEGACY_ISSUES, ...legacyFiller() };
  for (const [rel, content] of Object.entries(all)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}
