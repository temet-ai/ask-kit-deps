// Python, read from the files on disk: a virtual environment's site-packages (`*.dist-info/METADATA`,
// `RECORD`, `top_level.txt`), `uv.lock`, `pyproject.toml` and `requirements*.txt`. No pip is run here.
import fs from "node:fs";
import path from "node:path";
import { exists, isDir, posix, readText, redact, tomlStrings, tomlString, tomlTables } from "./util.mjs";

export const PY_MANIFESTS = ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"];
export const PY_LOCKS = ["uv.lock", "poetry.lock", "Pipfile.lock", "pdm.lock"];

/** PEP 503: names compare in lower case with runs of - _ . as one dash. */
export const normName = (n) => String(n).toLowerCase().replace(/[-_.]+/g, "-");

// A requirement string (PEP 508): `name[extras] spec ; marker` or `name @ url`.
export function parseRequirement(s) {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(String(s));
  if (!m) return null;
  let rest = m[3];
  let marker = null;
  const semi = rest.indexOf(";");
  if (semi >= 0) {
    marker = rest.slice(semi + 1).trim();
    rest = rest.slice(0, semi);
  }
  const spec = redact(rest.trim().replace(/^\((.*)\)$/, "$1").replace(/\s+/g, "")) || "*";
  return { name: normName(m[1]), shown: m[1], extras: m[2] ?? "", spec, marker };
}

const isReqFile = (f) => /^(requirements([-_.].*)?\.(txt|in)|.*[-_.]requirements\.txt|constraints.*\.txt)$/i.test(f);

export function findPythonRoot(start) {
  for (let d = start; ; d = path.dirname(d)) {
    if ([...PY_MANIFESTS, ...PY_LOCKS].some((f) => exists(path.join(d, f)))) return d;
    try {
      if (fs.readdirSync(d).some(isReqFile)) return d;
    } catch {}
    if (path.dirname(d) === d) return null;
  }
}

// The virtual environment: VENV when set, else the first of .venv, venv, env that holds a pyvenv.cfg.
function findVenv(root, setting) {
  for (const c of [setting, ".venv", "venv", "env", ".env"].filter(Boolean)) {
    const abs = path.resolve(root, c);
    if (!isDir(abs) || !exists(path.join(abs, "pyvenv.cfg"))) continue;
    const cfg = readText(path.join(abs, "pyvenv.cfg")) ?? "";
    const python = /^version(?:_info)?\s*=\s*([\d.]+)/m.exec(cfg)?.[1] ?? null;
    const sites = [];
    const lib = path.join(abs, "lib");
    try {
      for (const e of fs.readdirSync(lib)) if (/^python\d/.test(e) && isDir(path.join(lib, e, "site-packages"))) sites.push(path.join(lib, e, "site-packages"));
    } catch {}
    if (isDir(path.join(abs, "Lib", "site-packages"))) sites.push(path.join(abs, "Lib", "site-packages")); // Windows
    if (sites.length) return { dir: abs, site: sites[0], python };
  }
  return null;
}

// METADATA headers (RFC 822 style) up to the first blank line.
function parseMetadata(text) {
  const h = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) break;
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase();
    (h[k] ??= []).push(m[2]);
  }
  return h;
}

function licenceOf(h) {
  const expr = h["license-expression"]?.[0];
  if (expr) return expr;
  const cls = (h.classifier ?? []).filter((c) => c.startsWith("License ::")).map((c) => c.split("::").pop().trim()).filter((c) => c !== "OSI Approved");
  if (cls.length) return cls.join(" OR ");
  const l = h.license?.[0]?.trim();
  return l && l !== "UNKNOWN" && l.length <= 60 ? l : l ? "(licence text in METADATA)" : null;
}

function scanSite(site, root) {
  const nodes = new Map();
  let ents = [];
  try {
    ents = fs.readdirSync(site);
  } catch {}
  for (const e of ents) {
    const info = /\.dist-info$/.test(e) ? "METADATA" : /\.egg-info$/.test(e) ? "PKG-INFO" : null;
    if (!info) continue;
    const text = readText(path.join(site, e, info)) ?? readText(path.join(site, e)); // an .egg-info may be a file
    if (!text) continue;
    const h = parseMetadata(text);
    const shown = h.name?.[0];
    if (!shown) continue;
    const id = normName(shown);
    const top = (readText(path.join(site, e, "top_level.txt")) ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    nodes.set(id, {
      id,
      name: id,
      shown,
      version: h.version?.[0] ?? "?",
      dir: site,
      rel: posix(path.relative(root, path.join(site, e))),
      info: e,
      top,
      licence: licenceOf(h),
      summary: h.summary?.[0] ?? null,
      requiresPython: h["requires-python"]?.[0] ?? null,
      homepage: redact(h["home-page"]?.[0] ?? (h["project-url"] ?? []).map((u) => u.split(",").pop().trim())[0] ?? "") || null,
      wants: (h["requires-dist"] ?? []).map(parseRequirement).filter(Boolean),
    });
  }
  return nodes;
}

// uv.lock. Assumed: `[[package]]` tables with `name`, `version`, `source`, and `dependencies = [{ name = "x", ... }]`;
// `[package.optional-dependencies]` and `[package.dev-dependencies]` with `group = [{ name = "x" }]`;
// `[package.metadata]` with `requires-dist = [{ name = "x", specifier = ">=1" }]`. The project is
// the package whose source is `virtual` or `editable`.
function fromUvLock(text) {
  const nodes = new Map();
  let cur = null;
  let project = null;
  const names = (raw) => [...String(raw ?? "").matchAll(/\bname\s*=\s*"([^"]+)"/g)].map((m) => normName(m[1]));
  for (const t of tomlTables(text)) {
    if (t.header === "package" && t.array) {
      const name = tomlString(t.keys.name);
      if (!name) {
        cur = null;
        continue;
      }
      cur = { id: normName(name), name: normName(name), shown: name, version: tomlString(t.keys.version) ?? "?", dir: null, rel: null, licence: null, wants: names(t.keys.dependencies).map((n) => ({ name: n, spec: "*" })), devNames: [], optNames: [], specs: {} };
      if (/\b(virtual|editable)\s*=/.test(t.keys.source ?? "")) project = cur;
      nodes.set(cur.id, cur);
    } else if (cur && t.header === "package.dev-dependencies") for (const v of Object.values(t.keys)) cur.devNames.push(...names(v));
    else if (cur && t.header === "package.optional-dependencies") for (const v of Object.values(t.keys)) cur.optNames.push(...names(v));
    else if (cur && t.header === "package.metadata")
      for (const m of String(t.keys["requires-dist"] ?? "").matchAll(/\{([^}]*)\}/g)) {
        const n = /\bname\s*=\s*"([^"]+)"/.exec(m[1])?.[1];
        const s = /\bspecifier\s*=\s*"([^"]*)"/.exec(m[1])?.[1];
        if (n) cur.specs[normName(n)] = s || "*";
      }
    else if (t.header !== "package" && !t.header.startsWith("package.")) cur = null;
  }
  return { nodes, project };
}

// What the project declares. pyproject.toml: `[project] dependencies`, `[project.optional-dependencies]`,
// `[dependency-groups]`, `[tool.uv] dev-dependencies`, `[tool.poetry.dependencies]` and
// `[tool.poetry.group.<g>.dependencies]`. requirements files: one requirement per line; options
// (lines starting with -) are skipped apart from `-r other.txt`, which is followed once.
function declared(root) {
  const rows = [];
  const files = [];
  const add = (req, kind, from) => {
    const r = typeof req === "string" ? parseRequirement(req) : req;
    if (r && r.name !== "python" && !rows.some((x) => x.name === r.name && x.kind === kind)) rows.push({ name: r.name, range: r.spec, kind, from, marker: r.marker ?? undefined });
  };
  const text = readText(path.join(root, "pyproject.toml"));
  let project = { name: null, version: null };
  let usesUv = false;
  if (text) {
    files.push("pyproject.toml");
    for (const t of tomlTables(text)) {
      if (t.header === "project") {
        project = { name: tomlString(t.keys.name), version: tomlString(t.keys.version) };
        for (const s of tomlStrings(t.keys.dependencies)) add(s, "prod", "pyproject.toml");
      } else if (t.header === "project.optional-dependencies") for (const v of Object.values(t.keys)) for (const s of tomlStrings(v)) add(s, "optional", "pyproject.toml");
      else if (t.header === "dependency-groups") for (const v of Object.values(t.keys)) for (const s of tomlStrings(v)) add(s, "dev", "pyproject.toml");
      else if (t.header === "tool.uv") {
        usesUv = true;
        for (const s of tomlStrings(t.keys["dev-dependencies"])) add(s, "dev", "pyproject.toml");
      } else if (/^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/.test(t.header)) {
        const kind = t.header === "tool.poetry.dependencies" ? "prod" : "dev";
        for (const [k, v] of Object.entries(t.keys)) add({ name: normName(k), spec: redact(tomlString(v) ?? /version\s*=\s*"([^"]*)"/.exec(v)?.[1] ?? "*") }, kind, "pyproject.toml");
        if (t.header === "tool.poetry.dependencies") project.name ??= null;
      } else if (t.header === "tool.poetry") project = { name: project.name ?? tomlString(t.keys.name), version: project.version ?? tomlString(t.keys.version) };
      else if (t.header.startsWith("tool.uv")) usesUv = true;
    }
  }
  let reqFiles = [];
  try {
    reqFiles = fs.readdirSync(root).filter(isReqFile).sort();
  } catch {}
  const readReq = (file, depth) => {
    const t = readText(path.join(root, file));
    if (t === null) return;
    files.push(posix(file));
    const kind = /dev|test|lint|doc/i.test(file) ? "dev" : "prod";
    for (const raw of t.split(/\r?\n/)) {
      const line = raw.replace(/(^|\s)#.*$/, "").trim();
      if (!line) continue;
      const inc = /^(?:-r|--requirement)\s*=?\s*(\S+)/.exec(line);
      if (inc && depth < 2) readReq(path.join(path.dirname(file), inc[1]), depth + 1);
      else if (!line.startsWith("-")) add(line, kind, posix(file));
    }
  };
  for (const f of reqFiles) if (!files.includes(f) && !/^constraints/i.test(f)) readReq(f, 0);
  return { rows, files, project, usesUv };
}

export function loadPython(root, { venv: venvSetting } = {}) {
  const d = declared(root);
  const locks = PY_LOCKS.filter((l) => exists(path.join(root, l)));
  const venv = findVenv(root, venvSetting);
  const notes = [];
  const uvText = readText(path.join(root, "uv.lock"));
  const uv = uvText ? fromUvLock(uvText) : null;
  let nodes;
  let source;
  if (venv) {
    nodes = scanSite(venv.site, root);
    source = posix(path.relative(root, venv.site)) || ".";
  } else if (uv) {
    nodes = uv.nodes;
    if (uv.project) nodes.delete(uv.project.id);
    source = "uv.lock";
    notes.push("no virtual environment under the root (looked for .venv, venv, env), so nothing is installed; versions are the ones uv.lock pins");
  } else {
    nodes = new Map();
    source = null;
    notes.push(`no virtual environment under the root (looked for .venv, venv, env)${locks.length ? ` and ${locks.join(", ")} is not a lockfile this kit reads` : " and no uv.lock"}: only the declared requirements are known. Set VENV to the environment's folder if it lives elsewhere`);
  }
  // Declared rows: the manifest's, or the lock's project entry when the manifest names none.
  let rows = d.rows;
  if (!rows.length && uv?.project) {
    rows = [
      ...uv.project.wants.map((w) => ({ name: w.name, range: uv.project.specs[w.name] ?? "*", kind: "prod", from: "uv.lock" })),
      ...uv.project.devNames.map((n) => ({ name: n, range: uv.project.specs[n] ?? "*", kind: "dev", from: "uv.lock" })),
    ];
  }
  const self = d.project.name ? normName(d.project.name) : null;
  // The project installed into its own environment (editable) is not a dependency.
  if (self && nodes.has(self) && !rows.some((r) => r.name === self)) nodes.delete(self);
  const roots = rows.map((r) => ({ ...r, to: nodes.has(r.name) ? r.name : null }));

  for (const n of nodes.values()) {
    n.deps = [];
    for (const w of n.wants ?? []) {
      // A requirement behind an extra is installed only when someone asked for that extra; keep it when it is installed.
      const extra = /\bextra\s*==/.test(w.marker ?? "");
      if (!nodes.has(w.name) && (extra || w.marker)) continue;
      if (extra && !nodes.has(w.name)) continue;
      n.deps.push({ name: w.name, range: w.spec, to: nodes.has(w.name) ? w.name : null, kind: extra ? "optional" : "prod" });
    }
    delete n.wants;
    delete n.devNames;
    delete n.optNames;
    delete n.specs;
  }

  const pmName = locks.includes("uv.lock") || d.usesUv ? "uv" : locks.includes("poetry.lock") ? "poetry" : locks.includes("pdm.lock") ? "pdm" : locks.includes("Pipfile.lock") ? "pipenv" : "pip";
  return {
    eco: "python",
    root,
    source,
    onDisk: !!venv,
    manifests: d.files,
    lockfiles: locks,
    pm: { name: pmName },
    project: { name: d.project.name, version: d.project.version, venv: venv ? posix(path.relative(root, venv.dir)) || "." : null, python: venv?.python ?? null },
    venv,
    nodes,
    roots,
    notes,
  };
}

/** A distribution's files from its RECORD, as paths under site-packages; null when it has none. */
export function recordFiles(node) {
  const t = node.info ? readText(path.join(node.dir, node.info, "RECORD")) : null;
  if (t === null) return null;
  return t.split(/\r?\n/).map((l) => l.replace(/,[^,]*,[^,]*$/, "").replace(/^"|"$/g, "")).filter((f) => f && !f.startsWith("..") && !path.isAbsolute(f) && !/__pycache__|\.pyc$/.test(f));
}
