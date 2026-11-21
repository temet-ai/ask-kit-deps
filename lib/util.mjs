// Shared helpers: running a program with no shell, clipping, redaction, the secret-file rule,
// version comparison and npm range matching, and a bounded directory walk.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const deny = (why) => {
  throw new Error(`not allowed: ${why}`);
};

export const clip = (s, n = 300) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + ` [+${t.length - n} chars]` : t;
};

export const posix = (p) => p.split(path.sep).join("/");

// Credentials inside text: the userinfo of a URL, npm auth lines, and token-shaped values.
export const redact = (s) =>
  String(s ?? "")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+(?::[^\s/@"']*)?@/gi, "$1[redacted]@")
    .replace(/(_authToken|_auth|_password|password|token|secret|api[_-]?key)(\s*[=:]\s*)("?)[^\s"',}]+/gi, "$1$2$3[redacted]")
    .replace(/\b(npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{40,}|gh[pousr]_[A-Za-z0-9]{36,}|Bearer\s+[A-Za-z0-9._~+/=-]{20,})/g, "[redacted]");

// Files never opened, wherever they are: credentials and keys. What the investigator reads goes to a model.
const SECRET_FILE =
  /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.yarnrc(\.yml)?|\.pypirc|pip\.conf|pip\.ini|\.netrc|_netrc|credentials(\.toml|\.json)?|\.git-credentials|auth\.json|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*\.(pem|key|p12|pfx|jks|keystore|kdbx))$/i;
export const isSecretFile = (rel) => SECRET_FILE.test(posix(String(rel)));

/** Run a program with no shell. Never rejects: {code, out, err, timedOut?}; 127 when the program is missing. */
export function exec(file, args, { cwd, timeoutMs = 60_000, env } = {}) {
  return new Promise((resolve) => {
    // On Windows npm, pnpm and yarn are .cmd shims, which execFile cannot start directly: they go through cmd.exe,
    // so an argument holding a character cmd.exe gives meaning to is turned away first.
    const win = process.platform === "win32" && /^(npm|pnpm|yarn)$/.test(file);
    if (win && args.some((x) => /[&|<>^%!"\r\n]/.test(x))) return resolve({ code: 2, out: "", err: `an argument holds a character cmd.exe would interpret (& | < > ^ % ! "); ${file} was not run` });
    const [f, a] = win ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `${file}.cmd`, ...args]] : [file, args];
    execFile(f, a, { cwd, timeout: timeoutMs, maxBuffer: 64 << 20, encoding: "utf8", windowsHide: true, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1", npm_config_update_notifier: "false", npm_config_fund: "false", PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_INPUT: "1", ...env } }, (err, stdout, stderr) => {
      if (err?.code === "ENOENT") resolve({ code: 127, out: "", err: `${file} is not installed or not on PATH` });
      else resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout ?? "", err: stderr ?? "", ...(err?.killed ? { timedOut: true } : {}) });
    });
  });
}

export const readText = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
export const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
export const exists = (p) => fs.existsSync(p);
export const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// ---- versions ----

// Any dotted version: semver (1.2.3-rc.1+build), Go (v1.2.3), Python (2.31.0, 1.0rc1, 1.0.post1).
// {nums:[...], pre:[...]|null}; pre is null for a release.
export function parseVersion(v) {
  const m = /^[v=]?(\d+(?:\.\d+)*)(.*)$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const nums = m[1].split(".").map(Number);
  let rest = m[2].replace(/\+.*$/, "");
  let post = 0;
  const pm = /^[.-]?post(\d*)$/i.exec(rest);
  if (pm) {
    post = 1 + Number(pm[1] || 0);
    rest = "";
  }
  rest = rest.replace(/^[.-]/, "");
  return { nums, pre: rest ? rest.split(/[.]/) : null, post };
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return String(a).localeCompare(String(b));
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x.post !== y.post) return x.post < y.post ? -1 : 1;
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export const isPrerelease = (v) => !!parseVersion(v)?.pre;

/** The size of the step from one version to another: "major", "minor", "minor (0.x, may break)", "patch", "prerelease", "none", or null when either is not a version. */
export function step(from, to) {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return null;
  if (compareVersions(from, to) >= 0) return "none";
  if ((a.nums[0] ?? 0) !== (b.nums[0] ?? 0)) return "major";
  // Below 1.0 a minor step is where breaking changes go.
  if ((a.nums[1] ?? 0) !== (b.nums[1] ?? 0)) return (a.nums[0] ?? 0) === 0 ? "minor (0.x, may break)" : "minor";
  if ((a.nums[2] ?? 0) !== (b.nums[2] ?? 0)) return "patch";
  return "prerelease";
}

// npm ranges: ||, spaces (and), hyphen ranges, ^ ~ and x-ranges, and the comparators. Returns
// null for what is not a version range (a tag, a URL, workspace:, file:, git).
function comparators(part) {
  const out = [];
  const hy = /^\s*([v\d][^\s]*)\s+-\s+([v\d][^\s]*)\s*$/.exec(part);
  if (hy) {
    const lo = partial(hy[1]);
    const hi = partial(hy[2]);
    if (!lo || !hi) return null;
    out.push([">=", lo.floor]);
    out.push(hi.full ? ["<=", hi.floor] : ["<", hi.ceil]);
    return out;
  }
  for (const tok of part.trim().replace(/([<>=~^]+)\s+/g, "$1").split(/\s+/).filter(Boolean)) {
    const m = /^(\^|~>?|>=|<=|>|<|=)?(.*)$/.exec(tok);
    const op = m[1] ?? "";
    const p = partial(m[2]);
    if (!p) return null;
    if (p.any) {
      if (op === "<" || op === ">") out.push(["<", "0.0.0-0"]);
      continue;
    }
    if (op === "^") {
      const [M, mi, pa] = p.nums;
      const hi = M > 0 || p.given === 1 ? `${M + 1}.0.0` : mi > 0 || p.given === 2 ? `0.${mi + 1}.0` : `0.0.${pa + 1}`;
      out.push([">=", p.floor], ["<", hi + "-0"]);
    } else if (op.startsWith("~")) {
      const [M, mi] = p.nums;
      out.push([">=", p.floor], ["<", (p.given === 1 ? `${M + 1}.0.0` : `${M}.${mi + 1}.0`) + "-0"]);
    } else if (op === "" || op === "=") {
      if (p.full) out.push(["=", p.floor]);
      else out.push([">=", p.floor], ["<", p.ceil]);
    } else if (op === ">") out.push(p.full ? [">", p.floor] : [">=", p.ceil.replace(/-0$/, "")]);
    else if (op === "<=") out.push(p.full ? ["<=", p.floor] : ["<", p.ceil]);
    else out.push([op, p.floor]);
  }
  return out;
}

// "1", "1.2", "1.x", "1.2.3-rc.1", "*": the lowest version it names and the first one above it.
function partial(s) {
  const t = String(s).trim().replace(/^v/, "");
  if (t === "" || t === "*" || /^[xX]$/.test(t)) return { any: true };
  const m = /^(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(t);
  if (!m) return null;
  const num = (x) => (x === undefined || /[xX*]/.test(x) ? null : Number(x));
  const M = Number(m[1]);
  const mi = num(m[2]);
  const pa = mi === null ? null : num(m[3]);
  const given = mi === null ? 1 : pa === null ? 2 : 3;
  const nums = [M, mi ?? 0, pa ?? 0];
  return { nums, given, full: given === 3, floor: nums.join(".") + (given === 3 ? m[4] ?? "" : ""), ceil: (given === 1 ? `${M + 1}.0.0` : `${M}.${mi + 1}.0`) + "-0" };
}

export function satisfies(version, range) {
  const r = String(range ?? "").trim();
  if (!parseVersion(version)) return null;
  if (/^(npm:|workspace:|file:|link:|git|https?:|github:|catalog:|patch:|portal:)|\//.test(r) || /^[a-z][a-z-]*$/i.test(r)) return null;
  const pre = isPrerelease(version);
  const base = (v) => parseVersion(v).nums.slice(0, 3).join(".");
  let known = false;
  for (const part of r.split("||")) {
    const cs = comparators(part);
    if (!cs) continue;
    known = true;
    const ok = cs.every(([op, v]) => {
      const c = compareVersions(version, v);
      return op === "=" ? c === 0 : op === ">" ? c > 0 : op === ">=" ? c >= 0 : op === "<" ? c < 0 : c <= 0;
    });
    // A prerelease satisfies a range only when the range itself names a prerelease of the same version.
    if (ok && (!pre || cs.some(([, v]) => isPrerelease(v) && !v.endsWith("-0") && base(v) === base(version)))) return true;
  }
  return known ? false : null;
}

/** The highest of `versions` that satisfies the npm range, prereleases left out unless the range asks; null when none or the range is not a range. */
export function maxSatisfying(versions, range) {
  let best = null;
  for (const v of versions) if (satisfies(v, range) && (best === null || compareVersions(v, best) > 0)) best = v;
  return best;
}

// ---- files ----

/** A glob as a RegExp over forward-slash paths. `**` crosses folders, `*` does not; a glob with no slash matches the file name at any depth. */
export function globToRegExp(glob) {
  let g = String(glob);
  if (!g.includes("/")) g = "**/" + g;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += g[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += "(?:" + g.slice(i + 1, end).split(",").map((x) => x.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|") + ")";
        i = end;
      }
    } else re += /[.+^$()|[\]\\]/.test(c) ? "\\" + c : c;
  }
  return new RegExp("^" + re + "$", "i");
}

/** Files under dir as forward-slash relative paths, at most `max`; nested node_modules and VCS folders are skipped. {files, more}. */
export function walkFiles(dir, { max = 5000, skip = /^(node_modules|\.git|\.hg|\.svn|__pycache__)$/ } = {}) {
  const files = [];
  let more = false;
  const visit = (abs, rel) => {
    if (more) return;
    let ents;
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skip.test(e.name)) visit(path.join(abs, e.name), r);
      } else if (e.isFile()) {
        if (files.length >= max) {
          more = true;
          return;
        }
        files.push(r);
      }
    }
  };
  visit(dir, "");
  return { files, more };
}

/** Run `fn` over items, `n` at a time, keeping the order. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

// ---- narrow TOML and YAML ----

// TOML, as far as manifests and lockfiles need it. Assumed: one `key = value` per line, where a
// value may be an array or inline table that runs over several lines; table headers on their own
// line; no multi-line strings holding brackets. Returns [{header, array, keys:{key: rawValue}}]
// in file order; the first entry (header "") holds the top-level keys.
export function tomlTables(text) {
  const tables = [{ header: "", array: false, keys: {} }];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^\s*(\[\[?)\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (h && !/=/.test(line.split("]")[0])) {
      tables.push({ header: h[2].replace(/["']/g, ""), array: h[1] === "[[", keys: {} });
      continue;
    }
    const kv = /^\s*("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2];
    // Join following lines until brackets and braces outside strings are balanced.
    let depth = bracketDepth(value);
    while (depth > 0 && i + 1 < lines.length) {
      value += "\n" + lines[++i];
      depth = bracketDepth(value);
    }
    tables.at(-1).keys[kv[1].replace(/^["']|["']$/g, "")] = value.trim();
  }
  return tables;
}

function bracketDepth(s) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") {
      const nl = s.indexOf("\n", i);
      if (nl < 0) break;
      i = nl;
    } else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth;
}

/** The quoted strings in a raw TOML value, in order (the items of an array of strings). Comments are dropped. */
export function tomlStrings(raw) {
  const out = [];
  const s = String(raw ?? "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "#") {
      const nl = s.indexOf("\n", i);
      if (nl < 0) break;
      i = nl;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let v = "";
      while (j < s.length && s[j] !== c) {
        if (s[j] === "\\" && c === '"') j++;
        v += s[j++];
      }
      out.push(v);
      i = j;
    }
  }
  return out;
}

export const tomlString = (raw) => (raw === undefined ? null : /^\s*["']/.test(raw) ? tomlStrings(raw)[0] ?? null : null);

// YAML, as far as pnpm-lock.yaml, a yarn 2+ yarn.lock and pnpm-workspace.yaml need it. Assumed:
// block style with space indentation, `key: scalar` or `key:` opening a nested map, `- item`
// lists of scalars, keys optionally quoted; a flow value such as `{integrity: ...}` is kept as
// text. Returns nested plain objects, arrays for lists.
export function yamlLite(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const top = stack.at(-1);
    if (line.startsWith("- ")) {
      if (top.list) top.list.push(unquote(line.slice(2).trim()));
      continue;
    }
    const m = /^("(?:[^"\\]|\\.)*"|'[^']*'|.+?):(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const key = unquote(m[1]);
    if (m[2] === undefined || m[2] === "") {
      const node = {};
      const list = [];
      // Whether this key holds a map or a list is known only from its first child, so both are kept and the non-empty one wins.
      Object.defineProperty(top.node, key, { enumerable: true, configurable: true, get: () => (list.length ? list : node) });
      stack.push({ indent, node, list });
    } else top.node[key] = unquote(m[2]);
  }
  return root;
}
const unquote = (s) => (/^".*"$/.test(s) ? s.slice(1, -1).replace(/\\(.)/g, "$1") : /^'.*'$/.test(s) ? s.slice(1, -1) : s);
