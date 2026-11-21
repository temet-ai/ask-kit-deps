// Cargo and Go. Each is read through its own metadata command when the program is installed
// (`cargo metadata`, `go list -m -json all`, `go mod graph`), and narrowly from Cargo.lock,
// Cargo.toml and go.mod when it is not.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exists, isDir, posix, readText, redact, tomlString, tomlStrings, tomlTables } from "./util.mjs";

export const CARGO_MANIFESTS = ["Cargo.toml"];
export const GO_MANIFESTS = ["go.mod"];

export function findUp(start, names) {
  for (let d = start; ; d = path.dirname(d)) {
    if (names.some((f) => exists(path.join(d, f)))) return d;
    if (path.dirname(d) === d) return null;
  }
}

/** The outermost Cargo.toml that declares a [workspace] above the nearest one, else the nearest. */
export function findCargoRoot(start) {
  const near = findUp(start, CARGO_MANIFESTS);
  if (!near) return null;
  for (let d = path.dirname(near); path.dirname(d) !== d; d = path.dirname(d)) {
    const t = readText(path.join(d, "Cargo.toml"));
    if (t && /^\s*\[workspace\]/m.test(t)) return d;
  }
  return near;
}

const cargoHome = () => process.env.CARGO_HOME || path.join(os.homedir(), ".cargo");

// The unpacked source of a registry crate: ~/.cargo/registry/src/<index>/<name>-<version>.
function crateDir(name, version) {
  const src = path.join(cargoHome(), "registry", "src");
  try {
    for (const idx of fs.readdirSync(src)) {
      const d = path.join(src, idx, `${name}-${version}`);
      if (isDir(d)) return d;
    }
  } catch {}
  return null;
}

// Cargo.toml dependency tables. Assumed: `name = "req"`, `name = { version = "req", ... }` or a
// `[dependencies.name]` table with `version`; the same under dev-dependencies, build-dependencies
// and `target.<cfg>.dependencies`.
function cargoDeclared(text) {
  const rows = [];
  let name = null;
  let version = null;
  let members = [];
  for (const t of tomlTables(text)) {
    if (t.header === "package") {
      name = tomlString(t.keys.name);
      version = tomlString(t.keys.version);
    }
    if (t.header === "workspace") members = tomlStrings(t.keys.members);
    const m = /^(?:target\..+\.)?(dev-|build-)?dependencies(?:\.(.+))?$/.exec(t.header);
    if (!m) continue;
    const kind = m[1] === "dev-" ? "dev" : m[1] === "build-" ? "build" : "prod";
    const range = (v) => redact(tomlString(v) ?? /\bversion\s*=\s*"([^"]*)"/.exec(v)?.[1] ?? (/\bpath\s*=/.test(v) ? "path" : /\bgit\s*=/.test(v) ? "git" : /\bworkspace\s*=\s*true/.test(v) ? "workspace" : "*"));
    if (m[2]) rows.push({ name: m[2], range: redact(tomlString(t.keys.version) ?? "*"), kind });
    else for (const [k, v] of Object.entries(t.keys)) rows.push({ name: /\bpackage\s*=\s*"([^"]+)"/.exec(v)?.[1] ?? k, range: range(v), kind });
  }
  return { rows, name, version, members };
}

export async function loadCargo(root, run) {
  const manifest = readText(path.join(root, "Cargo.toml")) ?? "";
  const d = cargoDeclared(manifest);
  const locks = exists(path.join(root, "Cargo.lock")) ? ["Cargo.lock"] : [];
  const notes = [];
  const nodes = new Map();
  let roots = [];
  let source = null;
  let members = [];

  // --offline first: it needs no network when the lockfile and the registry cache are there. A failure falls back to the plain command.
  let r = await run("cargo", ["metadata", "--format-version", "1", "--offline"], root);
  if (r.code !== 0 && r.code !== 127) r = await run("cargo", ["metadata", "--format-version", "1"], root);
  let meta = null;
  if (r.code === 0) {
    try {
      meta = JSON.parse(r.out);
    } catch {}
  }
  if (meta?.resolve) {
    source = "cargo metadata";
    const ws = new Set(meta.workspace_members ?? []);
    for (const p of meta.packages ?? []) {
      const dir = path.dirname(p.manifest_path);
      nodes.set(p.id, { id: p.id, name: p.name, version: p.version, dir: isDir(dir) ? dir : null, rel: null, licence: p.license ?? (p.license_file ? "(licence file)" : null), summary: p.description ?? null, workspace: ws.has(p.id), homepage: redact(p.repository ?? p.homepage ?? "") || null, declares: p.dependencies ?? [], deps: [] });
    }
    for (const n of meta.resolve.nodes ?? []) {
      const node = nodes.get(n.id);
      if (!node) continue;
      for (const dep of n.deps ?? []) {
        const target = nodes.get(dep.pkg);
        if (!target) continue;
        const kinds = (dep.dep_kinds ?? []).map((k) => k.kind ?? "prod");
        const kind = kinds.includes("prod") || !kinds.length ? "prod" : kinds.includes("build") ? "build" : "dev";
        const req = node.declares.find((x) => (x.rename ?? x.name).replace(/-/g, "_") === dep.name || x.name === target.name)?.req ?? "*";
        node.deps.push({ name: target.name, range: req, to: dep.pkg, kind });
      }
    }
    for (const id of ws) {
      const m = nodes.get(id);
      if (!m) continue;
      members.push(m.name);
      for (const e of m.deps) roots.push({ name: e.name, range: e.range, kind: e.kind, from: posix(path.relative(root, path.join(m.dir ?? root, "Cargo.toml"))) || "Cargo.toml", to: e.to });
    }
    for (const n of nodes.values()) delete n.declares;
  } else {
    if (r.code === 127) notes.push("cargo is not installed: read from Cargo.lock and Cargo.toml, so licences and dependency kinds of transitive crates are not known");
    else notes.push(`cargo metadata failed (${redact((r.err || r.out).trim().split("\n").slice(-1)[0] ?? "").slice(0, 200)}): read from Cargo.lock and Cargo.toml`);
    // Cargo.lock. Assumed: `[[package]]` with `name`, `version` and `dependencies = ["name", "name version", ...]`.
    const lock = readText(path.join(root, "Cargo.lock"));
    if (lock) {
      source = "Cargo.lock";
      const raw = [];
      for (const t of tomlTables(lock)) {
        if (t.header !== "package" || !t.array) continue;
        const name = tomlString(t.keys.name);
        const version = tomlString(t.keys.version);
        if (!name || !version) continue;
        const id = `${name}@${version}`;
        const dir = t.keys.source ? crateDir(name, version) : null;
        nodes.set(id, { id, name, version, dir, rel: null, licence: null, workspace: !t.keys.source, deps: [] });
        raw.push([id, tomlStrings(t.keys.dependencies)]);
      }
      const byName = new Map();
      for (const n of nodes.values()) (byName.get(n.name) ?? byName.set(n.name, []).get(n.name)).push(n);
      for (const [id, deps] of raw)
        for (const s of deps) {
          const [name, version] = s.split(" ");
          const target = (byName.get(name) ?? []).find((n) => !version || n.version === version);
          nodes.get(id).deps.push({ name, range: version ?? "*", to: target?.id ?? null, kind: "prod" });
        }
      const names = new Set([d.name, ...[...nodes.values()].filter((n) => n.workspace).map((n) => n.name)].filter(Boolean));
      members = [...names];
      const self = [...nodes.values()].find((n) => n.name === d.name && n.workspace);
      roots = d.rows.map((row) => ({ ...row, from: "Cargo.toml", to: self?.deps.find((e) => e.name === row.name)?.to ?? (byName.get(row.name) ?? [])[0]?.id ?? null }));
    } else {
      roots = d.rows.map((row) => ({ ...row, from: "Cargo.toml", to: null }));
      notes.push("no Cargo.lock: only the declared requirements are known");
    }
  }
  // Workspace members are the project, not its dependencies.
  for (const [id, n] of nodes) if (n.workspace) nodes.delete(id);
  for (const n of nodes.values()) n.deps = n.deps.filter((e) => !e.to || nodes.has(e.to));
  roots = roots.filter((x) => !x.to || nodes.has(x.to));
  if ([...nodes.values()].some((n) => !n.dir)) notes.push("some crates have no source on this machine (not downloaded); files, read and search need `cargo fetch`");
  return { eco: "cargo", root, source, onDisk: [...nodes.values()].some((n) => n.dir), manifests: ["Cargo.toml"], lockfiles: locks, pm: { name: "cargo" }, project: { name: d.name ?? (members.length ? members.join(", ") : null), version: d.version, workspaces: d.members }, nodes, roots, notes };
}

// ---- Go ----

// The module cache folder of a module version: upper-case letters are written as "!" and the lower-case letter.
function goModDir(modPath, version) {
  const esc = (s) => s.replace(/[A-Z]/g, (c) => "!" + c.toLowerCase());
  const caches = [process.env.GOMODCACHE, ...(process.env.GOPATH ? process.env.GOPATH.split(path.delimiter).map((p) => path.join(p, "pkg", "mod")) : []), path.join(os.homedir(), "go", "pkg", "mod")].filter(Boolean);
  for (const c of caches) {
    const d = path.join(c, ...esc(modPath).split("/")) + "@" + esc(version);
    if (isDir(d)) return d;
  }
  return null;
}

// go.mod. Assumed: `module <path>`, `go <version>`, `require <path> <version> [// indirect]` on one
// line or inside a `require ( ... )` block, and `replace` lines, which are only noted.
function parseGoMod(text) {
  const out = { module: null, go: null, requires: [], replaces: 0 };
  let block = null;
  for (const raw of text.split(/\r?\n/)) {
    const indirect = /\/\/\s*indirect/.test(raw);
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (block) {
      if (line === ")") block = null;
      else if (block === "require") {
        const [p, v] = line.split(/\s+/);
        if (v) out.requires.push({ path: p, version: v, indirect });
      } else if (block === "replace") out.replaces++;
      continue;
    }
    const m = /^(module|go|require|replace|exclude|retract|toolchain)\s+(.*)$/.exec(line);
    if (!m) continue;
    if (m[2] === "(") block = m[1];
    else if (m[1] === "module") out.module = m[2].replace(/"/g, "");
    else if (m[1] === "go") out.go = m[2];
    else if (m[1] === "require") {
      const [p, v] = m[2].split(/\s+/);
      if (v) out.requires.push({ path: p, version: v, indirect });
    } else if (m[1] === "replace") out.replaces++;
  }
  return out;
}

export async function loadGo(root, run) {
  const mod = parseGoMod(readText(path.join(root, "go.mod")) ?? "");
  const locks = exists(path.join(root, "go.sum")) ? ["go.sum"] : [];
  const notes = [];
  const nodes = new Map();
  let roots = [];
  let source = "go.mod";
  const add = (p, version, extra = {}) => nodes.set(p, { id: p, name: p, version, dir: goModDir(p, version), rel: null, licence: null, deps: [], ...extra });

  // -mod=readonly: the listing never rewrites go.mod.
  // Offline first; when the module cache lacks a go.mod the listing is tried once more with the proxy, which downloads go.mod files into the cache.
  let r = await run("go", ["list", "-m", "-json", "all"], root, { GOFLAGS: "-mod=readonly", GOPROXY: "off" });
  if (r.code !== 0 && r.code !== 127) r = await run("go", ["list", "-m", "-json", "all"], root, { GOFLAGS: "-mod=readonly" });
  if (r.code === 0) {
    source = "go list -m -json all";
    // The output is JSON objects one after another, not an array.
    for (const chunk of r.out.split(/\n(?=\{)/)) {
      let m;
      try {
        m = JSON.parse(chunk);
      } catch {
        continue;
      }
      if (m.Main) continue;
      const eff = m.Replace ?? m;
      add(m.Path, eff.Version ?? m.Version ?? "(local)", { dir: eff.Dir && isDir(eff.Dir) ? eff.Dir : goModDir(eff.Path ?? m.Path, eff.Version ?? m.Version ?? ""), indirect: !!m.Indirect, replacedBy: m.Replace ? `${m.Replace.Path}${m.Replace.Version ? "@" + m.Replace.Version : ""}` : undefined });
    }
    const g = await run("go", ["mod", "graph"], root, { GOFLAGS: "-mod=readonly" });
    if (g.code === 0) {
      // Each line is `<module>[@version] <module>@version`: the first requires the second at that version.
      // The build uses one version per module, so edges are kept between the selected versions only.
      for (const line of g.out.split("\n")) {
        const [a, b] = line.trim().split(" ");
        if (!b) continue;
        const [ap, av] = a.split("@");
        const [bp, bv] = b.split("@");
        const from = nodes.get(ap);
        if (!from || !nodes.has(bp) || (av && from.version !== av)) continue;
        if (!from.deps.some((e) => e.to === bp)) from.deps.push({ name: bp, range: bv, to: bp, kind: "prod" });
      }
    } else notes.push(`go mod graph failed (${(g.err || g.out).trim().split("\n")[0].slice(0, 160)}): why has no chains`);
  } else {
    notes.push(r.code === 127 ? "go is not installed: read from go.mod, which lists modules but not what requires what, so why has no chains" : `go list failed (${(r.err || r.out).trim().split("\n")[0].slice(0, 200)}): read from go.mod, so why has no chains`);
    for (const q of mod.requires) add(q.path, q.version, { indirect: q.indirect });
  }
  roots = mod.requires.filter((q) => !q.indirect).map((q) => ({ name: q.path, range: q.version, kind: "prod", from: "go.mod", to: nodes.has(q.path) ? q.path : null }));
  if (mod.replaces) notes.push(`go.mod has ${mod.replaces} replace directive(s)`);
  if ([...nodes.values()].some((n) => !n.dir)) notes.push("some modules have no source in the module cache; files, read and search need `go mod download`");
  return { eco: "go", root, source, onDisk: [...nodes.values()].some((n) => n.dir), manifests: ["go.mod"], lockfiles: locks, pm: { name: "go" }, project: { name: mod.module, version: null, go: mod.go }, nodes, roots, notes };
}
