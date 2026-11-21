// The dependency graph of one ecosystem: which packages are direct, which are dev only, the
// shortest chains from a direct dependency to a package, and a licence guess from a LICENSE file.
import fs from "node:fs";
import path from "node:path";

// Marks each package as direct or not and dev or not, and indexes names and reverse edges.
export function finalize(t) {
  t.byName = new Map();
  t.rev = new Map();
  for (const n of t.nodes.values()) {
    (t.byName.get(n.name) ?? t.byName.set(n.name, []).get(n.name)).push(n);
    if (n.realName) (t.byName.get(n.realName) ?? t.byName.set(n.realName, []).get(n.realName)).push(n);
    for (const e of n.deps) if (e.to) (t.rev.get(e.to) ?? t.rev.set(e.to, []).get(e.to)).push({ from: n.id, range: e.range, kind: e.kind });
  }
  const rank = { prod: 0, optional: 1, peer: 2, build: 3, dev: 4 };
  for (const r of t.roots) {
    const n = r.to && t.nodes.get(r.to);
    if (!n) continue;
    if (!n.root || rank[r.kind] < rank[n.root.kind]) n.root = r;
  }
  // Reachable from a non-dev direct dependency means not dev. Dev edges below a crate (its own dev-dependencies) are not followed.
  const reach = (starts) => {
    const seen = new Set(starts);
    const q = [...starts];
    while (q.length) for (const e of t.nodes.get(q.pop())?.deps ?? []) if (e.to && e.kind !== "dev" && !seen.has(e.to)) seen.add(e.to) && q.push(e.to);
    return seen;
  };
  const prod = reach(t.roots.filter((r) => r.to && r.kind !== "dev").map((r) => r.to));
  const any = reach(t.roots.filter((r) => r.to).map((r) => r.to));
  for (const n of t.nodes.values()) {
    n.dev = any.has(n.id) && !prod.has(n.id);
    n.extraneous = !any.has(n.id) && !n.workspace;
  }
}

export const label = (n) => `${n.name}@${n.version}`;

// The shortest chains from a direct dependency down to a package, as text, shortest first.
export function chainsTo(t, id, max) {
  const out = [];
  const seen = new Set([id]);
  let frontier = [{ id, path: [] }]; // path: [{id, range}] from the package upward
  let visited = 0;
  while (frontier.length && out.length < max && visited < 50_000) {
    const next = [];
    for (const cur of frontier) {
      visited++;
      const n = t.nodes.get(cur.id);
      if (n.root) {
        const r = n.root;
        const head = `${label(n)} (declared ${r.range} in ${r.from}${r.kind === "prod" ? "" : ", " + r.kind})`;
        out.push([head, ...cur.path.map((p) => `${label(t.nodes.get(p.id))} (wanted ${p.range})`)].join(" > "));
        if (out.length >= max) break;
        if (cur.path.length) continue; // a direct dependency further up adds only longer chains
      }
      for (const e of t.rev.get(cur.id) ?? []) {
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        next.push({ id: e.from, path: [{ id: cur.id, range: e.range }, ...cur.path] });
      }
    }
    frontier = next;
  }
  return out;
}

/** The licence a LICENSE or COPYING file in `dir` names in its first lines: {licence, file}, or null. */
export function guessLicence(dir) {
  try {
    const file = fs.readdirSync(dir).find((x) => /^(licen[cs]e|copying|unlicense)(\.|-|$)/i.test(x));
    if (!file) return null;
    const head = fs.readFileSync(path.join(dir, file), "utf8").slice(0, 1500);
    const licence = /\bMIT License|Permission is hereby granted, free of charge/i.test(head) ? "MIT"
      : /Apache License\s+Version 2\.0/i.test(head) ? "Apache-2.0"
      : /GNU AFFERO GENERAL PUBLIC/i.test(head) ? "AGPL"
      : /GNU LESSER GENERAL PUBLIC/i.test(head) ? "LGPL"
      : /GNU GENERAL PUBLIC LICENSE/i.test(head) ? "GPL"
      : /Mozilla Public License/i.test(head) ? "MPL-2.0"
      : /\bISC License|Permission to use, copy, modify, and\/or distribute/i.test(head) ? "ISC"
      : /Redistribution and use in source and binary forms/i.test(head) ? "BSD"
      : /This is free and unencumbered software/i.test(head) ? "Unlicense"
      : null;
    return licence ? { licence, file } : null;
  } catch {
    return null;
  }
}
