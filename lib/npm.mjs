// npm, pnpm and yarn, read from the files on disk: package.json, node_modules and the lockfile.
// No package manager is run here.
//
// A tree is {nodes: Map(id -> node), roots: [...]}. With node_modules present the nodes are what
// is installed (id = the folder's path under the root); without it they come from the lockfile,
// and nothing is installed.
import fs from "node:fs";
import path from "node:path";
import { exists, isDir, posix, readJson, readText, redact, yamlLite } from "./util.mjs";

export const NPM_MANIFESTS = ["package.json"];
export const NPM_LOCKS = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

const licenceOf = (pj) => {
  const l = pj.license ?? pj.licence ?? pj.licenses;
  if (!l) return null;
  if (typeof l === "string") return l;
  if (Array.isArray(l)) return l.map((x) => (typeof x === "string" ? x : x?.type)).filter(Boolean).join(" OR ") || null;
  return l.type ?? null;
};

// Workspace folders: package.json `workspaces` (an array, or {packages}) and pnpm-workspace.yaml
// `packages`. Assumed: each pattern is a literal folder, `dir/*` or `dir/**`; negations are skipped.
function workspaceDirs(root, pj) {
  const pats = [].concat(Array.isArray(pj?.workspaces) ? pj.workspaces : pj?.workspaces?.packages ?? []);
  const y = readText(path.join(root, "pnpm-workspace.yaml"));
  if (y) pats.push(...[].concat(yamlLite(y).packages ?? []));
  const out = new Set();
  const add = (rel) => exists(path.join(root, rel, "package.json")) && out.add(posix(rel));
  const children = (rel, deep, depth = 0) => {
    let ents = [];
    try {
      ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {}
    for (const e of ents) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      add(r);
      if (deep && depth < 3) children(r, deep, depth + 1);
    }
  };
  for (const p of pats.map(String)) {
    if (p.startsWith("!")) continue;
    const clean = p.replace(/^\.\//, "").replace(/\/$/, "");
    if (clean.endsWith("/**") || clean.endsWith("/**/*")) children(clean.replace(/\/\*\*(\/\*)?$/, ""), true);
    else if (clean.endsWith("/*")) children(clean.slice(0, -2), false);
    // `.` (pnpm-workspace.yaml often lists the root itself) is the project, not a member: counting it twice lists every dependency twice.
    else if (!clean.includes("*") && clean !== "." && clean !== "") add(clean);
  }
  return [...out].sort();
}

const DEP_FIELDS = [["dependencies", "prod"], ["devDependencies", "dev"], ["optionalDependencies", "optional"], ["peerDependencies", "peer"]];

function manifestDeps(pj) {
  const rows = [];
  const seen = new Set();
  for (const [field, kind] of DEP_FIELDS)
    for (const [name, range] of Object.entries(pj?.[field] ?? {})) {
      if (seen.has(name)) continue; // a peer dependency that is also a dev dependency counts once, as the earlier kind
      seen.add(name);
      rows.push({ name, range: redact(String(range)), kind });
    }
  return rows;
}

// ---- node_modules on disk ----

function scanNodeModules(root, starts) {
  const nodes = new Map();
  const links = new Map(); // a symlink's key -> the key of the folder it points at
  const seenReal = new Set();
  const keyOf = (abs) => posix(path.relative(root, abs));

  const addPackage = (abs, key, name) => {
    const pj = readJson(path.join(abs, "package.json"));
    if (!pj || typeof pj !== "object" || !pj.version) return false; // not a package: a stray folder, or a nested {"type":"module"} marker
    nodes.set(key, {
      id: key,
      name,
      realName: pj.name && pj.name !== name ? pj.name : undefined,
      version: String(pj.version),
      dir: abs,
      rel: key,
      licence: licenceOf(pj),
      deprecated: undefined,
      wants: { ...pj.peerDependencies, ...pj.optionalDependencies, ...pj.dependencies },
      optional: new Set([...Object.keys(pj.optionalDependencies ?? {}), ...Object.keys(pj.peerDependenciesMeta ?? {}).filter((k) => pj.peerDependenciesMeta[k]?.optional)]),
      peer: new Set(Object.keys(pj.peerDependencies ?? {}).filter((k) => !(k in (pj.dependencies ?? {})))),
    });
    return true;
  };

  const visitModules = (nmAbs) => {
    let real;
    try {
      real = fs.realpathSync(nmAbs);
    } catch {
      return;
    }
    if (seenReal.has(real)) return;
    seenReal.add(real);
    let ents;
    try {
      ents = fs.readdirSync(nmAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name === ".pnpm") {
        // pnpm's store of real folders: .pnpm/<name>@<version>/node_modules/<name>
        let inner = [];
        try {
          inner = fs.readdirSync(path.join(nmAbs, ".pnpm"), { withFileTypes: true });
        } catch {}
        for (const d of inner) if (d.isDirectory() && d.name !== "node_modules") visitModules(path.join(nmAbs, ".pnpm", d.name, "node_modules"));
        continue;
      }
      if (e.name.startsWith(".")) continue;
      if (e.name.startsWith("@")) {
        let scoped = [];
        try {
          scoped = fs.readdirSync(path.join(nmAbs, e.name), { withFileTypes: true });
        } catch {}
        for (const s of scoped) visitEntry(path.join(nmAbs, e.name, s.name), `${e.name}/${s.name}`, s);
      } else visitEntry(path.join(nmAbs, e.name), e.name, e);
    }
  };

  const visitEntry = (abs, name, ent) => {
    const key = keyOf(abs);
    if (ent.isSymbolicLink()) {
      let real;
      try {
        real = fs.realpathSync(abs);
      } catch {
        return; // a dangling link
      }
      const rkey = keyOf(real);
      links.set(key, rkey);
      if (!nodes.has(rkey) && !rkey.startsWith("..")) {
        // A workspace member, or a pnpm store folder not walked yet.
        if (addPackage(real, rkey, name)) {
          if (!rkey.includes("node_modules")) nodes.get(rkey).workspace = true;
          visitModules(path.join(real, "node_modules"));
        }
      }
      return;
    }
    if (!ent.isDirectory()) return;
    if (addPackage(abs, key, name)) visitModules(path.join(abs, "node_modules"));
  };

  for (const s of starts) visitModules(path.join(root, s, "node_modules"));
  return { nodes, links };
}

// Node's own lookup, on keys: from a folder, try <folder>/node_modules/<name>, then each parent.
function resolveKey(nodes, links, fromKey, name) {
  let d = fromKey;
  for (;;) {
    const cand = (d ? d + "/" : "") + "node_modules/" + name;
    const hit = nodes.has(cand) ? cand : links.has(cand) && nodes.has(links.get(cand)) ? links.get(cand) : null;
    if (hit) return hit;
    if (!d) return null;
    const i = d.lastIndexOf("/");
    d = i < 0 ? "" : d.slice(0, i);
  }
}

// ---- lockfiles ----

// package-lock.json and npm-shrinkwrap.json, lockfileVersion 2 or 3 (`packages`), or 1 (`dependencies`, nested).
function fromPackageLock(lock) {
  const nodes = new Map();
  const links = new Map();
  const put = (key, e) => {
    const name = e.name && key.endsWith("/" + e.name) ? e.name : key.slice(key.lastIndexOf("node_modules/") + 13);
    nodes.set(key, {
      id: key,
      name,
      realName: e.name && e.name !== name ? e.name : undefined,
      version: String(e.version ?? "?"),
      dir: null,
      rel: key,
      licence: typeof e.license === "string" ? e.license : null,
      deprecated: e.deprecated ? String(e.deprecated) : undefined,
      lockDev: !!e.dev,
      wants: { ...e.peerDependencies, ...e.optionalDependencies, ...e.dependencies, ...e.requires },
      optional: new Set([...Object.keys(e.optionalDependencies ?? {}), ...Object.keys(e.peerDependenciesMeta ?? {})]),
      peer: new Set(Object.keys(e.peerDependencies ?? {})),
    });
  };
  if (lock.packages) {
    for (const [key, e] of Object.entries(lock.packages)) {
      if (key === "") continue;
      if (e.link) links.set(key, e.resolved);
      else if (key.includes("node_modules/")) put(key, e);
      else {
        // a workspace member
        put(key, { ...e, name: e.name ?? key });
        nodes.get(key).name = e.name ?? key;
        nodes.get(key).workspace = true;
      }
    }
  } else {
    const walk = (deps, prefix) => {
      for (const [name, e] of Object.entries(deps ?? {})) {
        const key = `${prefix}node_modules/${name}`;
        put(key, e);
        walk(e.dependencies, key + "/");
      }
    };
    walk(lock.dependencies, "");
    // In version 1 `dependencies` of an entry are nested installs, and `requires` are its wants.
    for (const n of nodes.values()) n.wants = {};
    const wants = (deps, prefix) => {
      for (const [name, e] of Object.entries(deps ?? {})) {
        const key = `${prefix}node_modules/${name}`;
        nodes.get(key).wants = { ...e.requires };
        wants(e.dependencies, key + "/");
      }
    };
    wants(lock.dependencies, "");
  }
  return { nodes, links };
}

// pnpm-lock.yaml, lockfileVersion 6 to 9. Assumed: `importers.<dir>.<dependencies|devDependencies|
// optionalDependencies>.<name>.{specifier, version}` (version 6 of a single project puts those
// three maps at the top level); package keys `/name@version`, `name@version` or `/name/version`,
// with a peer suffix in brackets; the dependency maps under `snapshots` (9) or `packages` (6).
function fromPnpmLock(text) {
  const y = yamlLite(text);
  const nodes = new Map();
  const strip = (k) => k.replace(/^\//, "");
  const split = (k) => {
    const s = strip(k);
    const m = /^(@?[^@/]+(?:\/[^@/]+)?)[@/]([^(]+)(\(.*\))?$/.exec(s);
    return m ? { name: m[1], version: m[2] } : null;
  };
  const snaps = y.snapshots ?? y.packages ?? {};
  for (const [k, e] of Object.entries(snaps)) {
    const nv = split(k);
    if (!nv) continue;
    const meta = y.packages?.[k] ?? y.packages?.[`${nv.name}@${nv.version}`] ?? {};
    nodes.set(strip(k), {
      id: strip(k),
      name: nv.name,
      version: nv.version,
      dir: null,
      rel: null,
      licence: null,
      deprecated: typeof meta.deprecated === "string" ? meta.deprecated : undefined,
      lockDev: e.dev === "true",
      wants: { ...(typeof e.optionalDependencies === "object" ? e.optionalDependencies : {}), ...(typeof e.dependencies === "object" ? e.dependencies : {}) },
      optional: new Set(Object.keys(typeof e.optionalDependencies === "object" ? e.optionalDependencies : {})),
      peer: new Set(),
      pinned: true, // `wants` hold resolved versions, not ranges
    });
  }
  const find = (name, version) => {
    const v = String(version);
    for (const id of [`${name}@${v}`, `${name}/${v}`, v]) if (nodes.has(id)) return id;
    const bare = v.replace(/\(.*$/, "");
    for (const id of [`${name}@${bare}`, `${name}/${bare}`]) if (nodes.has(id)) return id;
    return null;
  };
  const importers = y.importers ?? { ".": y };
  const roots = [];
  for (const [dir, imp] of Object.entries(importers))
    for (const [field, kind] of DEP_FIELDS) {
      const m = imp?.[field];
      if (!m || typeof m !== "object") continue;
      for (const [name, v] of Object.entries(m)) {
        const version = typeof v === "object" ? v.version : v;
        const range = typeof v === "object" ? v.specifier : y.specifiers?.[name];
        roots.push({ name, range: redact(String(range ?? version)), kind, from: dir === "." ? "package.json" : `${dir}/package.json`, to: find(name, version) });
      }
    }
  return { nodes, roots, resolve: (node, name, want) => find(name, want), version: String(y.lockfileVersion ?? "") };
}

// yarn.lock. Version 1 is yarn's own format (`"a@^1", a@^2:` then indented `version "1.2.3"` and a
// `dependencies:` block); yarn 2+ is YAML with keys like "a@npm:^1.0.0" and `version: 1.2.3`.
function fromYarnLock(text) {
  const nodes = new Map();
  const bySpec = new Map(); // "name@range" -> node id
  const berry = /^__metadata:/m.test(text);
  const entries = [];
  if (berry) {
    for (const [k, e] of Object.entries(yamlLite(text))) {
      if (k === "__metadata" || typeof e !== "object") continue;
      entries.push({ specs: k.split(/,\s*/), version: e.version, deps: { ...(typeof e.dependencies === "object" ? e.dependencies : {}) }, opt: Object.keys(typeof e.optionalDependencies === "object" ? e.optionalDependencies : {}), workspace: /@workspace:/.test(k) });
    }
  } else {
    let cur = null;
    let inDeps = false;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith("#")) continue;
      if (!line.startsWith(" ")) {
        cur = { specs: line.replace(/:\s*$/, "").split(/,\s*/).map((s) => s.replace(/^"|"$/g, "")), version: null, deps: {}, opt: [] };
        entries.push(cur);
        inDeps = false;
      } else if (cur) {
        const m = /^(\s+)("?[^"\s]+"?)\s*(.*)$/.exec(line);
        if (!m) continue;
        if (m[1].length === 2) {
          inDeps = /^(dependencies|optionalDependencies):?$/.test(m[2] + m[3]);
          if (m[2] === "version") cur.version = m[3].replace(/"/g, "");
        } else if (inDeps) cur.deps[m[2].replace(/"/g, "")] = m[3].replace(/"/g, "");
      }
    }
  }
  for (const e of entries) {
    if (!e.version || e.workspace) continue;
    const name = e.specs[0].replace(/^(@?[^@]+)@.*$/, "$1");
    const id = `${name}@${e.version}`;
    if (!nodes.has(id)) nodes.set(id, { id, name, version: String(e.version), dir: null, rel: null, licence: null, wants: e.deps, optional: new Set(e.opt), peer: new Set() });
    for (const s of e.specs) bySpec.set(s, id);
  }
  const resolve = (node, name, range) => bySpec.get(`${name}@${range}`) ?? bySpec.get(`${name}@npm:${range}`) ?? bySpec.get(`${name}@${String(range).replace(/^npm:/, "")}`) ?? null;
  return { nodes, resolve, berry };
}

// ---- the tree ----

function detectPm(root, pj, locks) {
  const field = typeof pj?.packageManager === "string" ? /^(npm|pnpm|yarn|bun)@([^+\s]+)/.exec(pj.packageManager) : null;
  if (field) return { name: field[1], declared: field[2] };
  if (locks.includes("pnpm-lock.yaml")) return { name: "pnpm" };
  if (locks.includes("yarn.lock")) return { name: "yarn" };
  if (locks.some((l) => l.startsWith("bun.lock"))) return { name: "bun" };
  if (exists(path.join(root, "node_modules", ".pnpm"))) return { name: "pnpm" };
  return { name: "npm" };
}

/** The nearest folder at or above `start` that holds a lockfile or node_modules, else the nearest package.json. */
export function findNpmRoot(start) {
  let firstManifest = null;
  for (let d = start; ; d = path.dirname(d)) {
    const hasPj = exists(path.join(d, "package.json"));
    if (hasPj && !firstManifest) firstManifest = d;
    if (hasPj && (NPM_LOCKS.some((l) => exists(path.join(d, l))) || isDir(path.join(d, "node_modules")))) return d;
    if (path.dirname(d) === d) return firstManifest;
  }
}

export function loadNpm(root) {
  const pj = readJson(path.join(root, "package.json")) ?? {};
  const locks = NPM_LOCKS.filter((l) => exists(path.join(root, l)));
  const members = workspaceDirs(root, pj);
  const manifests = [{ rel: "package.json", key: "", pj }, ...members.map((m) => ({ rel: `${m}/package.json`, key: m, pj: readJson(path.join(root, m, "package.json")) ?? {} }))];
  const notes = [];
  const hasModules = isDir(path.join(root, "node_modules"));
  const lockJson = ["package-lock.json", "npm-shrinkwrap.json"].map((l) => readJson(path.join(root, l))).find(Boolean) ?? null;

  let nodes;
  let source;
  let resolveDep; // (fromKey|node, name, range) -> id|null
  let roots = null;
  let lockVersion = lockJson?.lockfileVersion ? String(lockJson.lockfileVersion) : null;

  if (hasModules) {
    const s = scanNodeModules(root, ["", ...members]);
    nodes = s.nodes;
    source = "node_modules";
    resolveDep = (from, name) => resolveKey(nodes, s.links, typeof from === "string" ? from : from.id, name);
    // The lockfile adds what the folders do not say: deprecation notices.
    if (lockJson?.packages) for (const [k, e] of Object.entries(lockJson.packages)) if (e.deprecated && nodes.has(k)) nodes.get(k).deprecated = String(e.deprecated);
  } else if (lockJson) {
    const s = fromPackageLock(lockJson);
    nodes = s.nodes;
    source = exists(path.join(root, "package-lock.json")) ? "package-lock.json" : "npm-shrinkwrap.json";
    resolveDep = (from, name) => resolveKey(nodes, s.links, typeof from === "string" ? from : from.id, name);
  } else if (locks.includes("pnpm-lock.yaml")) {
    const s = fromPnpmLock(readText(path.join(root, "pnpm-lock.yaml")) ?? "");
    nodes = s.nodes;
    roots = s.roots;
    source = "pnpm-lock.yaml";
    lockVersion = s.version;
    resolveDep = s.resolve;
  } else if (locks.includes("yarn.lock")) {
    const s = fromYarnLock(readText(path.join(root, "yarn.lock")) ?? "");
    nodes = s.nodes;
    source = "yarn.lock";
    lockVersion = s.berry ? "yarn 2+" : "1";
    resolveDep = s.resolve;
  } else {
    nodes = new Map();
    source = null;
    resolveDep = () => null;
    notes.push(locks.length ? `no node_modules, and ${locks.join(", ")} is not a lockfile this kit reads` : "no node_modules and no lockfile: only package.json's declared ranges are known");
  }
  if (!hasModules && source) notes.push(`node_modules is absent, so nothing is installed; versions are the ones ${source} pins`);
  if (hasModules && exists(path.join(root, ".pnp.cjs"))) notes.push("the project uses Yarn Plug'n'Play; node_modules does not hold its packages");

  roots ??= manifests.flatMap((m) => manifestDeps(m.pj).map((d) => ({ ...d, from: m.rel, to: resolveDep(m.key, d.name, d.range) })));

  // Resolve every node's wants to edges.
  for (const n of nodes.values()) {
    n.deps = [];
    for (const [name, range] of Object.entries(n.wants ?? {})) {
      const to = resolveDep(n, name, range);
      if (!to && (n.optional?.has(name) || n.peer?.has(name))) continue; // an optional or peer dependency that was not installed
      n.deps.push({ name, range: redact(String(range)), to, kind: n.peer?.has(name) ? "peer" : n.optional?.has(name) ? "optional" : "prod" });
    }
    delete n.wants;
    delete n.optional;
    delete n.peer;
  }

  return {
    eco: "npm",
    root,
    source,
    onDisk: hasModules,
    manifests: manifests.map((m) => m.rel),
    lockfiles: locks,
    lockVersion,
    pm: detectPm(root, pj, locks),
    project: { name: pj.name ?? null, version: pj.version ?? null, workspaces: members },
    nodes,
    roots,
    notes,
  };
}
