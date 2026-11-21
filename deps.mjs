// The packages a project depends on, for ask-kit: which version of a package is installed and
// which is declared, what requires it, and the files of the installed copy (its API, README and
// changelog in the installed version). npm, pnpm and yarn projects and Python environments are
// read from the files on disk, so no package manager is needed; Cargo and Go through `cargo
// metadata` and `go list` when the program is there. `pm()` runs the project's package manager
// with no shell: reading commands always, changing ones only when the caller asked for a change.
//
// Never opened or printed: .npmrc, .pypirc, pip.conf, .netrc, .yarnrc.yml, cargo and uv credential
// files, and .env or key files inside a package. Answers go to a cloud model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classify, PROGRAMS } from "./lib/pm.mjs";
import { chainsTo, finalize, guessLicence, label } from "./lib/graph.mjs";
import { makeNet } from "./lib/net.mjs";
import { findNpmRoot, loadNpm } from "./lib/npm.mjs";
import { findPythonRoot, loadPython, normName, recordFiles } from "./lib/python.mjs";
import { findCargoRoot, findUp, loadCargo, loadGo } from "./lib/native.mjs";
import { clip, compareVersions, deny, exec, globToRegExp, isDir, isSecretFile, posix, redact, walkFiles } from "./lib/util.mjs";

const ECOS = ["npm", "python", "cargo", "go"];
const ALIAS = { node: "npm", js: "npm", javascript: "npm", pnpm: "npm", yarn: "npm", bun: "npm", py: "python", pip: "python", uv: "python", pypi: "python", poetry: "python", rust: "cargo", crates: "cargo", golang: "go" };
const PM_CHOICES = { npm: ["npm", "pnpm", "yarn", "bun"], python: ["uv", "pip", "poetry"], cargo: ["cargo"], go: ["go"] };
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|bz2|xz|7z|wasm|node|so|dylib|dll|exe|a|o|rlib|pyc|pyd|woff2?|ttf|otf|eot|mp[34]|mov|bin|dat|map)$/i;

const tilde = (p) => {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? "~" + posix(p.slice(home.length)) : posix(p);
};

export function make({ settings = {}, push = () => {}, act = false } = {}) {
  return makeDeps({ dir: path.resolve(settings.WORKDIR || process.cwd()), settings, push, act: act === true });
}

export function makeDeps({ dir, settings = {}, push = () => {}, act = false }) {
  const net = makeNet({ push, osvUrl: String(settings.OSV_URL || "https://api.osv.dev").replace(/\/$/, "") });
  const run = async (program, args, cwd, env, timeoutMs = 60_000) => {
    const started = Date.now();
    const r = await exec(program, args, { cwd, env, timeoutMs });
    push({ kind: "cmd", detail: redact(`${program} ${args.join(" ")}`).slice(0, 200), ms: Date.now() - started, code: r.code, size: r.out.length });
    return r;
  };

  // ---- where the project is ----

  let rootsCache = null;
  const roots = () => {
    if (rootsCache && Date.now() - rootsCache.at < 15_000) return rootsCache.value;
    const found = { npm: findNpmRoot(dir), python: findPythonRoot(dir), cargo: findCargoRoot(dir), go: findUp(dir, ["go.mod"]) };
    // The nearest project first: it is the one the question is about.
    const order = ECOS.filter((e) => found[e]).sort((a, b) => found[b].length - found[a].length);
    rootsCache = { at: Date.now(), value: { found, order } };
    return rootsCache.value;
  };

  const MANIFEST_NAMES = /^(package\.json|pyproject\.toml|requirements.*\.txt|uv\.lock|Cargo\.toml|go\.mod)$/;
  const nested = () => {
    const out = [];
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
        let inner = [];
        try {
          inner = fs.readdirSync(path.join(dir, e.name));
        } catch {}
        const m = inner.filter((f) => MANIFEST_NAMES.test(f));
        if (m.length) out.push(`${e.name} (${m.join(", ")})`);
        if (out.length >= 20) break;
      }
    } catch {}
    return out;
  };
  const noProject = () => {
    if (!isDir(dir)) return new Error(`the folder ${tilde(dir)} does not exist; give dir relative to the caller's folder`);
    const n = nested();
    return new Error(`no project at or above ${tilde(dir)}: no package.json, pyproject.toml, requirements*.txt, uv.lock, Cargo.toml or go.mod.${n.length ? ` Folders below that hold one: ${n.join("; ")}. Use deps.at("<folder>"), or the scripts' dir param.` : ""}`);
  };

  const canon = (eco) => {
    const e = ALIAS[String(eco).toLowerCase()] ?? String(eco).toLowerCase();
    if (!ECOS.includes(e)) throw new Error(`unknown eco "${eco}"; use one of ${ECOS.join(", ")}`);
    return e;
  };
  const ecosFor = (eco) => {
    const { found, order } = roots();
    if (!order.length) throw noProject();
    if (eco == null) return order;
    const e = canon(eco);
    if (!found[e]) throw new Error(`no ${e} project at or above ${tilde(dir)}; found here: ${order.join(", ")}`);
    return [e];
  };

  // ---- trees ----

  const trees = new Map();
  async function tree(eco) {
    const hit = trees.get(eco);
    if (hit && Date.now() - hit.at < 15_000) return hit.tree;
    const root = roots().found[eco];
    const started = Date.now();
    const t = eco === "npm" ? loadNpm(root) : eco === "python" ? loadPython(root, { venv: settings.VENV }) : eco === "cargo" ? await loadCargo(root, run) : await loadGo(root, run);
    finalize(t);
    push({ kind: "read", detail: `${eco}: ${t.source ?? "manifest only"} at ${tilde(root)}`, ms: Date.now() - started, code: 0, size: t.nodes.size });
    trees.set(eco, { at: Date.now(), tree: t });
    return t;
  }

  const throughOf = (t, n) => {
    if (n.root) return null;
    const c = chainsTo(t, n.id, 1)[0];
    return c ? c.split(" > ").slice(0, -1).map((s) => s.replace(/ \((declared|wanted) .*$/, "")).join(" > ") : null;
  };

  const shownPath = (t, n) => n.rel ?? (n.dir ? tilde(n.dir) : null);
  const row = (t, n, { through = true } = {}) => ({
    eco: t.eco,
    name: n.name,
    version: n.version,
    ...(n.realName ? { aliasOf: n.realName } : {}),
    path: shownPath(t, n),
    installed: !!n.dir,
    direct: !!n.root,
    ...(n.root ? { declared: n.root.range, kind: n.root.kind, from: n.root.from } : {}),
    dev: n.dev,
    ...(through && !n.root ? { through: throughOf(t, n) ?? (n.extraneous ? "(nothing requires it: extraneous)" : null) } : {}),
    ...(n.deprecated ? { deprecated: clip(n.deprecated, 160) } : {}),
    ...(n.workspace ? { workspace: true } : {}),
  });

  const sameName = (eco, a, b) => (eco === "python" ? normName(a) === normName(b) : a === b);
  const byNameThenVersion = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : compareVersions(b.version, a.version));

  // The packages a name means, in the given ecosystems: exact matches, else names that contain it.
  async function match(name, eco) {
    const q = String(name);
    const hits = [];
    for (const e of ecosFor(eco)) {
      const t = await tree(e);
      const key = e === "python" ? normName(q) : q;
      for (const n of t.byName.get(key) ?? []) hits.push({ t, n });
    }
    if (hits.length) return { match: "exact", hits };
    const low = q.toLowerCase();
    // The name without its scope or module path: "watch" for @ankh-morpork/watch, "gin" for github.com/gin-gonic/gin.
    for (const e of ecosFor(eco)) {
      const t = await tree(e);
      for (const n of t.nodes.values()) if (n.name.includes("/") && n.name.split("/").pop().toLowerCase() === low) hits.push({ t, n });
    }
    if (hits.length && new Set(hits.map((h) => h.n.name)).size === 1) return { match: "basename", hits };
    hits.length = 0;
    for (const e of ecosFor(eco)) {
      const t = await tree(e);
      for (const n of t.nodes.values()) if (n.name.toLowerCase().includes(low) || n.realName?.toLowerCase().includes(low)) hits.push({ t, n });
    }
    return { match: hits.length ? "substring" : "none", hits };
  }

  const suggest = async (eco) => {
    const names = [];
    for (const e of ecosFor(eco)) names.push(...(await tree(e)).roots.map((r) => r.name));
    return [...new Set(names)].slice(0, 25).join(", ") || "(none declared)";
  };

  // One installed copy of one package, for files, read and search. Throws with the names or versions that exist.
  async function one(name, { eco, version } = {}) {
    if (!name) throw new Error("a package name is needed");
    const m = await match(name, eco);
    if (m.match === "none") throw new Error(`no package "${name}" here; direct dependencies: ${await suggest(eco)}. deps.installed("<part of the name>") searches all of them`);
    const names = [...new Set(m.hits.map((h) => h.n.name))];
    if (names.length > 1 && m.match === "substring") throw new Error(`several packages match "${name}": ${names.slice(0, 20).join(", ")}${names.length > 20 ? ` and ${names.length - 20} more` : ""}; name one`);
    let hits = m.hits;
    if (version) {
      hits = hits.filter((h) => h.n.version === String(version).replace(/^v(?=\d)/, "") || h.n.version === String(version));
      if (!hits.length) throw new Error(`${names[0]} is not here in version ${version}; have: ${m.hits.map((h) => h.n.version).join(", ")}`);
    }
    // Several copies: the direct one, else the highest version.
    hits.sort((a, b) => (b.n.root ? 1 : 0) - (a.n.root ? 1 : 0) || compareVersions(b.n.version, a.n.version));
    const { t, n } = hits[0];
    if (!n.dir) throw new Error(`${label(n)} is not on this machine (${t.onDisk ? "its source was not downloaded" : `nothing is installed; ${t.source} only pins it`}), so its files cannot be read. ${t.eco === "npm" ? "Install first (deps.pm(\"install\") with act: true)" : t.eco === "cargo" ? "Run `cargo fetch` first" : t.eco === "go" ? "Run `go mod download` first" : "Create the environment first"}`);
    return { t, n, matched: m.match, otherVersions: hits.slice(1).map((h) => `${h.n.version} at ${shownPath(h.t, h.n)}`) };
  }

  const fileLists = new Map();
  function listFiles(t, n) {
    const key = `${t.eco} ${n.id} ${n.dir}`;
    if (fileLists.has(key)) return fileLists.get(key);
    let v;
    if (t.eco === "python") {
      const rec = recordFiles(n);
      if (rec) v = { files: rec.sort(), more: false, exact: true };
      else {
        const files = [];
        for (const top of n.top ?? []) {
          if (isDir(path.join(n.dir, top))) files.push(...walkFiles(path.join(n.dir, top), { max: 5000 }).files.map((f) => `${top}/${f}`));
          else if (fs.existsSync(path.join(n.dir, top + ".py"))) files.push(top + ".py");
        }
        v = { files, more: false, exact: true };
      }
    } else v = walkFiles(n.dir, { max: 8000 });
    if (fileLists.size > 40) fileLists.clear();
    fileLists.set(key, v);
    return v;
  }

  // A path inside a package, checked: no escape, no secret file, and for Python a file the distribution owns.
  function inside(t, n, relPath) {
    if (relPath == null || relPath === "") throw new Error("a path inside the package is needed; deps.files(name) lists them");
    const rel = posix(path.normalize(String(relPath))).replace(/^\.\//, "");
    if (path.isAbsolute(String(relPath)) || rel.startsWith("..")) deny(`${relPath} is outside ${label(n)}; give a path inside the package, as deps.files() lists them`);
    if (isSecretFile(rel)) deny(`${rel} may hold credentials or keys, and what you read goes to a model. Read the package's code and docs instead`);
    const abs = path.join(n.dir, rel);
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      return { rel, abs: null };
    }
    const base = fs.realpathSync(n.dir);
    if (real !== base && !real.startsWith(base + path.sep)) deny(`${rel} is a link that leaves ${label(n)}`);
    if (t.eco === "python") {
      const list = listFiles(t, n);
      if (!list.files.includes(rel)) return { rel, abs: null };
    }
    return { rel, abs: real };
  }

  const readTextFile = (abs, maxBytes = 4 << 20) => {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { error: "not a file" };
    if (st.size > maxBytes) return { error: `the file is ${Math.round(st.size / 1024)} KB, too large to read whole; use deps.search() on it` };
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 2000).includes(0)) return { error: "a binary file", size: st.size };
    return { text: buf.toString("utf8") };
  };

  const pmVersions = new Map();
  async function pmVersion(name, cwd) {
    if (!PROGRAMS[name]) return null;
    if (!pmVersions.has(name)) {
      const r = await run(name, [name === "go" ? "version" : "--version"], cwd, {}, 10_000);
      pmVersions.set(name, r.code === 0 ? /\d+\.\d+(\.\d+)?[\w.-]*/.exec(r.out)?.[0] ?? r.out.trim().split("\n")[0].slice(0, 40) : null);
    }
    return pmVersions.get(name);
  }

  // ---- the package manager ----

  async function programFor(eco, program) {
    const e = ecosFor(eco)[0];
    const t = await tree(e);
    let name = program ? String(program) : t.pm.name;
    if (!PM_CHOICES[e].includes(name)) {
      if (program) throw new Error(`${program} is not a package manager of the ${e} ecosystem; use ${PM_CHOICES[e].join(", ")}, or pass eco`);
      name = PM_CHOICES[e].at(e === "python" ? 1 : 0); // pdm and pipenv projects are read with pip
    }
    if (name !== "pip") return { name, file: name, prefix: [], cwd: t.root, t };
    // pip of the project's own environment, so it reports that environment's packages.
    const py = t.venv ? [path.join(t.venv.dir, "bin", "python"), path.join(t.venv.dir, "Scripts", "python.exe")].find((p) => fs.existsSync(p)) : null;
    return { name, file: py ?? (process.platform === "win32" ? "python" : "python3"), prefix: ["-m", "pip"], cwd: t.root, t };
  }

  async function runPm(p, args, timeoutMs) {
    const env = p.name === "go" ? { GOFLAGS: process.env.GOFLAGS ?? "" } : {};
    const r = await run(p.file, [...p.prefix, ...args], p.cwd, env, timeoutMs);
    const cap = 120_000;
    const out = redact(r.out);
    return { program: p.name, command: redact(`${p.name} ${args.join(" ")}`), code: r.code, out: out.length > cap ? out.slice(0, cap) + `\n[output cut at ${cap} characters of ${out.length}]` : out, err: redact(r.err).slice(0, 4000), ...(r.timedOut ? { timedOut: true } : {}) };
  }
  // The acting path exists only in an ask that asked for a change.
  const runActing = act ? (p, args) => runPm(p, args, 300_000) : null;

  const api = {
    /** The folder questions are about. */
    dir,

    /** The same functions for another folder (relative to this one): deps.at("services/api").installed("x"). */
    at: (sub) => makeDeps({ dir: path.resolve(dir, String(sub)), settings, push, act }),

    /** The project: nearest root, every ecosystem found with its manifests, lockfiles, package manager and counts. Never throws: with no project, ecosystems is empty and `note` says what was looked for. */
    async project() {
      const { found, order } = roots();
      if (!order.length) return { dir: tilde(dir), root: null, ecosystems: [], note: noProject().message };
      const ecosystems = [];
      for (const e of order) {
        const t = await tree(e);
        const direct = t.roots;
        const version = await pmVersion(t.pm.name, t.root);
        const multi = [...t.byName.entries()].filter(([name, list]) => new Set(list.filter((n) => n.name === name).map((n) => n.version)).size > 1).length;
        ecosystems.push({
          eco: e,
          root: tilde(found[e]),
          project: t.project,
          manifests: t.manifests,
          lockfiles: t.lockfiles,
          ...(t.lockVersion ? { lockfileVersion: t.lockVersion } : {}),
          packageManager: { name: t.pm.name, version, ...(t.pm.declared ? { declared: t.pm.declared } : {}), onPath: version !== null },
          readFrom: t.source,
          installed: t.onDisk,
          direct: { total: direct.length, dev: direct.filter((r) => r.kind === "dev").length, notInstalled: direct.filter((r) => !r.to || !t.nodes.get(r.to)?.dir).length },
          packages: t.nodes.size,
          transitive: [...t.nodes.values()].filter((n) => !n.root && !n.workspace).length,
          withSeveralVersions: multi,
          ...(t.notes.length ? { notes: t.notes } : {}),
        });
      }
      return { dir: tilde(dir), root: tilde(found[order[0]]), ecosystems };
    },

    /** What the project declares: one row per direct dependency with the declared range and the installed version (null when it is not installed). */
    async direct(o = {}) {
      const rows = [];
      for (const e of ecosFor(o.eco)) {
        const t = await tree(e);
        for (const r of t.roots) {
          const n = r.to ? t.nodes.get(r.to) : null;
          rows.push({ eco: e, name: r.name, declared: r.range, kind: r.kind, from: r.from, version: n?.version ?? null, installed: !!n?.dir, path: n ? shownPath(t, n) : null, ...(n?.deprecated ? { deprecated: clip(n.deprecated, 160) } : {}), ...(n?.workspace ? { workspace: true } : {}) });
        }
      }
      return rows;
    },

    /**
     * Installed packages. With a name: every copy of it (exact name first, else names containing it), with its path, whether it is direct,
     * the declared range, dev or not, and through which direct dependency it came. Without: all of them, at most o.max (default 200).
     * Never throws for an unknown name: match is "none".
     */
    async installed(name, o = {}) {
      if (name && typeof name === "object") [name, o] = [undefined, name];
      const max = Math.min(o.max ?? 200, 1000);
      let hits;
      let how = "all";
      if (name) {
        const m = await match(name, o.eco);
        hits = m.hits;
        how = m.match;
      } else {
        hits = [];
        for (const e of ecosFor(o.eco)) {
          const t = await tree(e);
          for (const n of t.nodes.values()) hits.push({ t, n });
        }
      }
      hits.sort((a, b) => ECOS.indexOf(a.t.eco) - ECOS.indexOf(b.t.eco) || byNameThenVersion(a.n, b.n));
      // Declared but absent: the answer to "which version do we have" is then "none".
      const missing = [];
      const sources = [];
      for (const e of ecosFor(o.eco)) {
        const t = await tree(e);
        sources.push(`${e}: ${t.source ?? "manifest only"}${t.onDisk ? "" : " (nothing installed)"}`);
        for (const r of t.roots) if (!r.to && (!name || sameName(e, r.name, name) || r.name.toLowerCase().includes(String(name).toLowerCase()))) missing.push({ eco: e, name: r.name, declared: r.range, kind: r.kind, from: r.from });
      }
      return {
        query: name ?? null,
        match: how,
        readFrom: sources,
        total: hits.length,
        packages: hits.slice(0, max).map(({ t, n }) => row(t, n, { through: !!name || hits.length <= 60 })),
        ...(hits.length > max ? { more: hits.length - max } : {}),
        ...(missing.length ? { declaredButNotInstalled: missing.slice(0, 50) } : {}),
      };
    },

    /**
     * Why a package is there: for each installed copy, the shortest chains from a direct dependency down to it (o.max of them, default 3)
     * and what requires it directly. Never throws for an unknown name: match is "none".
     */
    async why(name, o = {}) {
      if (!name) throw new Error("why needs a package name");
      const m = await match(name, o.eco);
      const names = [...new Set(m.hits.map((h) => h.n.name))];
      if (m.match === "none") return { query: name, match: "none", copies: [], note: `no package "${name}" is installed or pinned here; direct dependencies: ${await suggest(o.eco)}` };
      if (m.match === "substring" && names.length > 1) return { query: name, match: "substring", copies: [], candidates: names.slice(0, 40), note: `several packages contain "${name}"; ask about one of the candidates` };
      let hits = m.hits;
      if (o.version) hits = hits.filter((h) => h.n.version === String(o.version));
      hits.sort((a, b) => compareVersions(b.n.version, a.n.version));
      const copies = hits.slice(0, 6).map(({ t, n }) => {
        const req = (t.rev.get(n.id) ?? []).map((e) => `${label(t.nodes.get(e.from))} wants ${e.range}${e.kind === "prod" ? "" : ` (${e.kind})`}`);
        return {
          eco: t.eco,
          package: label(n),
          path: shownPath(t, n),
          direct: !!n.root,
          ...(n.root ? { declared: `${n.root.range} in ${n.root.from}${n.root.kind === "prod" ? "" : ` (${n.root.kind})`}` } : {}),
          dev: n.dev,
          chains: chainsTo(t, n.id, Math.min(o.max ?? 3, 10)),
          requiredBy: req.slice(0, 8),
          ...(req.length > 8 ? { moreRequiredBy: req.length - 8 } : {}),
          ...(n.extraneous ? { note: "nothing in the project requires it (extraneous)" } : {}),
        };
      });
      return { query: name, match: m.match, package: names[0], copies, ...(hits.length > 6 ? { moreCopies: hits.length - 6 } : {}) };
    },

    /** The files of the installed copy of one package: forward-slash paths inside it, filtered by o.glob, at most o.max (default 200). */
    async files(name, o = {}) {
      const { t, n, matched, otherVersions } = await one(name, o);
      const list = listFiles(t, n);
      const re = o.glob ? globToRegExp(o.glob) : null;
      const files = (re ? list.files.filter((f) => re.test(f)) : list.files).filter((f) => !isSecretFile(f));
      const max = Math.min(o.max ?? 200, 2000);
      return { package: label(n), eco: t.eco, matched, dir: t.eco === "python" ? posix(path.relative(t.root, n.dir)) : shownPath(t, n), total: files.length, files: files.slice(0, max), ...(files.length > max ? { more: files.length - max } : {}), ...(list.more ? { note: "the package has more files than were listed; narrow with glob" } : {}), ...(otherVersions.length ? { otherVersions } : {}) };
    },

    /**
     * Lines of one file of an installed package, numbered: o.start (default 1), o.lines (default 120, at most 400).
     * A missing file is returned as {error, nearby}; a path outside the package or a credentials file is refused.
     */
    async read(name, relPath, o = {}) {
      const { t, n } = await one(name, o);
      const p = inside(t, n, relPath);
      const pkg = label(n);
      if (!p.abs) {
        const base = p.rel.split("/").pop().toLowerCase();
        const near = listFiles(t, n).files.filter((f) => f.toLowerCase().endsWith("/" + base) || f.toLowerCase() === base || f.startsWith(p.rel.split("/").slice(0, -1).join("/") + "/")).slice(0, 15);
        return { package: pkg, path: p.rel, error: `no file ${p.rel} in ${pkg}`, nearby: near };
      }
      const started = Date.now();
      const f = readTextFile(p.abs);
      push({ kind: "file", detail: `${pkg} ${p.rel}`, ms: Date.now() - started, code: f.error ? 1 : 0, size: f.text?.length ?? 0 });
      if (f.error) return { package: pkg, path: p.rel, error: f.error };
      const all = f.text.split(/\r?\n/);
      const start = Math.max(1, Math.floor(o.start ?? 1));
      const count = Math.min(Math.max(1, Math.floor(o.lines ?? 120)), 400);
      const out = [];
      let size = 0;
      let end = start - 1;
      for (let i = start; i <= all.length && i < start + count; i++) {
        const line = `${i}: ${clip(all[i - 1], 400)}`;
        if (size + line.length > 24_000) break;
        out.push(line);
        size += line.length + 1;
        end = i;
      }
      return { package: pkg, path: p.rel, start, end, totalLines: all.length, cite: `${pkg} ${p.rel}:${start}-${end}`, text: redact(out.join("\n")), ...(end < all.length ? { next: `start: ${end + 1}` } : {}) };
    },

    /**
     * Search the installed copy of one package with a regular expression: [{at: "path:line", text}], at most o.max (default 40).
     * o.glob narrows the files ("*.d.ts", "dist/**"); letters match any case unless the pattern has a capital. Bounded in files, size and time.
     */
    async search(name, pattern, o = {}) {
      if (!pattern) throw new Error("search needs a pattern");
      const { t, n } = await one(name, o);
      let re;
      const flags = /[A-Z]/.test(String(pattern)) ? "" : "i";
      try {
        re = new RegExp(String(pattern), flags);
      } catch {
        re = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
      }
      const glob = o.glob ? globToRegExp(o.glob) : null;
      const max = Math.min(o.max ?? 40, 200);
      const ctx = Math.min(Math.max(0, o.context ?? 0), 3);
      const list = listFiles(t, n);
      const files = list.files.filter((f) => (glob ? glob.test(f) : !/\.min\.[cm]?js$/.test(f)) && !BINARY_EXT.test(f) && !isSecretFile(f));
      const matches = [];
      let count = 0;
      let searched = 0;
      let skipped = 0;
      const started = Date.now();
      let partial = false;
      for (const rel of files) {
        if (Date.now() - started > 6000 || searched >= 4000) {
          partial = true;
          break;
        }
        let text;
        try {
          const abs = path.join(n.dir, rel);
          if (fs.statSync(abs).size > 2 << 20) {
            skipped++;
            continue;
          }
          text = fs.readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        searched++;
        if (text.includes("\u0000") || !re.test(text)) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          count++;
          if (matches.length < max) matches.push({ at: `${rel}:${i + 1}`, text: redact(ctx ? lines.slice(Math.max(0, i - ctx), i + ctx + 1).map((l) => clip(l, 240)).join("\n") : clip(lines[i].trim(), 300)) });
        }
      }
      push({ kind: "search", detail: `${label(n)} /${String(pattern).slice(0, 80)}/`, ms: Date.now() - started, code: 0, size: count });
      return { package: label(n), pattern: String(pattern), count, matches, ...(count > matches.length ? { more: count - matches.length } : {}), filesSearched: searched, ...(skipped ? { skippedLargeFiles: skipped } : {}), ...(partial ? { partial: "stopped at the time or file limit; narrow with glob" } : {}) };
    },

    /**
     * The project's package manager with no shell: pm("ls", "--all"), pm("view", "zod", "version"), pm("pip", "list"), pm("tree", "-i", "itoa").
     * A last argument {eco, program} chooses the ecosystem or another program of it. Reading commands always run. Commands that change the
     * project run only when the caller asked for a change; commands that print credentials, publish or run project code are refused.
     * Never throws on a non-zero exit: {program, command, code, out, err}.
     */
    async pm(...args) {
      const o = args.length && typeof args.at(-1) === "object" && args.at(-1) !== null ? args.pop() : {};
      const a = args.flat().map(String);
      const p = await programFor(o.eco, o.program);
      const c = classify(p.name, a);
      if (c.kind === "act") {
        if (!runActing) throw new Error(`not in this ask: ${p.name} ${c.phrase} changes things, and the caller did not ask for a change (act: true), so nothing was done. Answer what you can, and say that this needs \`ask\` with act: true.`);
        const r = await runActing(p, a);
        trees.clear();
        fileLists.clear();
        return r;
      }
      return runPm(p, a, 120_000);
    },

    /**
     * What the public registry says about a package: {name, eco, ok, latest, wanted, count, recent:[newest releases], deprecated, error}.
     * o.range (default: the declared range when the package is direct) gives `wanted`. Offline or unknown packages come back with ok false and an error.
     */
    async registry(name, o = {}) {
      if (!name) throw new Error("registry needs a package name");
      const ecos = o.eco ? [canon(o.eco)] : roots().order.length ? roots().order : ["npm"];
      let eco = ecos[0];
      let range = o.range;
      for (const e of ecos) {
        if (!roots().found[e]) continue;
        const t = await tree(e);
        const key = e === "python" ? normName(name) : name;
        const r = t.roots.find((x) => x.name === key);
        if (r || t.byName.has(key)) {
          eco = e;
          range ??= r?.range;
          break;
        }
      }
      return net.registry(eco, eco === "python" ? normName(name) : String(name), { range });
    },

    /**
     * Known advisories for everything installed (or pinned) in one ecosystem: {eco, ok, source, checked, advisories:[{name, version, severity, title, id, url,
     * vulnerable, fixedIn, direct, dev, through}], error}. Offline comes back with ok false and an error.
     */
    async advisories(o = {}) {
      const e = ecosFor(o.eco)[0];
      const t = await tree(e);
      const pkgs = [...t.nodes.values()].filter((n) => !n.workspace).map((n) => ({ name: n.realName ?? n.name, version: n.version }));
      const r = await net.advisories(e, pkgs);
      const find = (a) => [...t.nodes.values()].find((n) => (n.realName ?? n.name) === a.name && n.version === a.version);
      return { eco: e, ...r, advisories: r.advisories.map((a) => {
        const n = find(a);
        return { ...a, direct: !!n?.root, dev: !!n?.dev, through: n && !n.root ? throughOf(t, n) : null };
      }) };
    },

    /** Every installed package's licence as the package states it: [{eco, name, version, licence}] (licence null when it states none). For the licences script. */
    async licences(o = {}) {
      const rows = [];
      for (const e of ecosFor(o.eco)) {
        const t = await tree(e);
        for (const n of t.nodes.values()) {
          if (n.workspace) continue;
          let licence = n.licence ?? null;
          let from = licence ? "manifest" : null;
          // No licence in the metadata: the first lines of a LICENSE file often name it.
          if (!licence && n.dir && t.eco !== "python") {
            const g = guessLicence(n.dir);
            if (g) [licence, from] = [g.licence, `${g.file} (guessed from its text)`];
          }
          rows.push({ eco: e, name: n.name, version: n.version, licence, ...(from && from !== "manifest" ? { from } : {}), direct: !!n.root, dev: n.dev });
        }
      }
      return rows;
    },

    /** For the scripts: one package's folder and manifest. {eco, package, name, version, dir, manifest (package.json as an object, npm only), modules (Python top-level names), homepage}. */
    async locate(name, o = {}) {
      const { t, n, matched, otherVersions } = await one(name, o);
      let manifest = null;
      if (t.eco === "npm") {
        try {
          manifest = JSON.parse(fs.readFileSync(path.join(n.dir, "package.json"), "utf8"));
        } catch {}
      }
      const pick = manifest ? Object.fromEntries(["name", "version", "description", "type", "main", "module", "types", "typings", "exports", "bin", "engines", "homepage", "license", "sideEffects", "peerDependencies"].filter((k) => k in manifest).map((k) => [k, manifest[k]])) : null;
      if (pick && manifest.repository) pick.repository = redact(typeof manifest.repository === "string" ? manifest.repository : manifest.repository.url ?? "");
      return { eco: t.eco, package: label(n), name: n.name, version: n.version, matched, dir: shownPath(t, n), direct: !!n.root, manifest: pick, modules: n.top ?? null, summary: n.summary ?? pick?.description ?? null, homepage: n.homepage ?? pick?.homepage ?? null, ...(otherVersions.length ? { otherVersions } : {}) };
    },

    /** For the scripts: the whole text of one file of a package, or null when it is missing, binary or too large. The same refusals as read(). */
    async text(name, relPath, o = {}) {
      const { t, n } = await one(name, o);
      const p = inside(t, n, relPath);
      if (!p.abs) return null;
      try {
        return readTextFile(p.abs, 3 << 20).text ?? null;
      } catch {
        return null;
      }
    },
  };
  return api;
}
