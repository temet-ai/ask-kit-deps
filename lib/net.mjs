// The registries: latest versions (npm, PyPI, the crates.io index, the Go module proxy) and known
// advisories (npm's bulk advisory endpoint, PyPI's per-release vulnerabilities, OSV for Cargo and
// Go). Public registries only: the kit never reads .npmrc or pip.conf, so a private registry is
// not asked; use deps.pm("outdated") or deps.pm("audit") for those.
import { execFile } from "node:child_process";
import { compareVersions, isPrerelease, maxSatisfying, parseVersion, pool, redact, satisfies } from "./util.mjs";

const NETWORK = /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|aborted|timeout|network/i;

// Node's fetch ignores HTTPS_PROXY unless the process was started with NODE_USE_ENV_PROXY=1
// (Node 22.21 and later). When a direct request fails and a proxy is set, the request is made
// once more from a short-lived child Node started that way.
const CHILD = `let s="";process.stdin.on("data",d=>s+=d).on("end",async()=>{const q=JSON.parse(s);try{const r=await fetch(q.url,{method:q.method,headers:q.headers,body:q.body,signal:AbortSignal.timeout(q.timeoutMs)});process.stdout.write(JSON.stringify({status:r.status,text:await r.text()}))}catch(e){process.stdout.write(JSON.stringify({error:String(e.cause?.message||e.message)}))}})`;
function viaProxy(q) {
  return new Promise((resolve) => {
    const c = execFile(process.execPath, ["-e", CHILD], { timeout: q.timeoutMs + 5000, maxBuffer: 64 << 20, env: { ...process.env, NODE_USE_ENV_PROXY: "1", NODE_NO_WARNINGS: "1" } }, (err, out) => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ error: err ? String(err.message).slice(0, 200) : "no answer through the proxy" });
      }
    });
    c.stdin.end(JSON.stringify(q));
  });
}

export function makeNet({ push, osvUrl }) {
  /** One request. Never throws: {ok, status, json, error}. */
  async function http(url, { method = "GET", body, headers = {}, timeoutMs = 15_000 } = {}) {
    const started = Date.now();
    const q = { url, method, headers: { "user-agent": "ask-kit-deps", ...headers }, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs };
    if (q.body) q.headers["content-type"] = "application/json";
    let res;
    try {
      const r = await fetch(url, { method, headers: q.headers, body: q.body, signal: AbortSignal.timeout(timeoutMs) });
      res = { status: r.status, text: await r.text() };
    } catch (e) {
      res = { error: String(e.cause?.code || e.cause?.message || e.message) };
      if ((process.env.HTTPS_PROXY || process.env.https_proxy) && NETWORK.test(String(e.message) + res.error)) {
        const again = await viaProxy(q);
        if (!again.error) res = again;
      }
    }
    push({ kind: "http", detail: `${method} ${redact(url)}`.slice(0, 200), ms: Date.now() - started, code: res.status ?? -1, size: res.text?.length ?? 0 });
    if (res.error) return { ok: false, status: 0, error: `could not reach ${new URL(url).host}: ${res.error}` };
    let json = null;
    try {
      json = JSON.parse(res.text);
    } catch {}
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json, text: json ? undefined : res.text, error: res.status >= 400 ? `${new URL(url).host} answered ${res.status}` : undefined };
  }

  const stable = (versions) => versions.filter((v) => parseVersion(v) && !isPrerelease(v)).sort(compareVersions);

  // A Python specifier set (PEP 440): comma-separated clauses with ==, !=, >=, <=, >, <, ~= and a trailing .* on == and !=.
  const pySatisfies = (v, spec) => {
    if (!spec || spec === "*") return true;
    return spec.split(",").every((c) => {
      const m = /^\s*(===|==|!=|~=|>=|<=|>|<)\s*([^\s]+)\s*$/.exec(c);
      if (!m) return true;
      const [, op, want] = m;
      if (want.endsWith(".*")) {
        const pre = want.slice(0, -2);
        const hit = v === pre || v.startsWith(pre + ".");
        return op === "!=" ? !hit : hit;
      }
      const cmp = compareVersions(v, want);
      if (op === "~=") {
        const nums = parseVersion(want)?.nums ?? [];
        const upper = [...nums.slice(0, -2), (nums.at(-2) ?? 0) + 1].join(".");
        return cmp >= 0 && compareVersions(v, upper) < 0;
      }
      return op === "==" || op === "===" ? cmp === 0 : op === "!=" ? cmp !== 0 : op === ">=" ? cmp >= 0 : op === "<=" ? cmp <= 0 : op === ">" ? cmp > 0 : cmp < 0;
    });
  };

  // A Cargo requirement: comma-separated; a bare version means caret.
  const cargoRange = (req) => String(req).split(",").map((c) => (/^\s*\d/.test(c) ? "^" + c.trim() : c.trim())).join(" ");
  const goEscape = (p) => p.replace(/[A-Z]/g, (c) => "!" + c.toLowerCase());

  /**
   * What the public registry says about one package: {name, eco, ok, latest, wanted, count, recent, deprecated, error}.
   * `wanted` is the highest release that satisfies `range` (the declared requirement); prereleases are left out.
   */
  async function registry(eco, name, { range } = {}) {
    const out = { name, eco, ok: false, latest: null, wanted: null };
    let versions = [];
    if (eco === "npm") {
      const r = await http(`https://registry.npmjs.org/${name.replace("/", "%2f")}`, { headers: { accept: "application/vnd.npm.install-v1+json" } });
      if (!r.ok || !r.json?.versions) return { ...out, error: r.status === 404 ? "not on the public npm registry (private, or a workspace package)" : r.error ?? "unexpected answer" };
      versions = Object.keys(r.json.versions);
      out.latest = r.json["dist-tags"]?.latest ?? stable(versions).at(-1) ?? null;
      const dep = r.json.versions[out.latest]?.deprecated;
      if (dep) out.deprecated = String(dep).slice(0, 200);
      if (range) out.wanted = maxSatisfying(versions, range);
    } else if (eco === "python") {
      const r = await http(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
      if (!r.ok || !r.json?.info) return { ...out, error: r.status === 404 ? "not on PyPI (private, or a local package)" : r.error ?? "unexpected answer" };
      versions = Object.entries(r.json.releases ?? {}).filter(([, files]) => !files.length || files.some((f) => !f.yanked)).map(([v]) => v);
      out.latest = r.json.info.version;
      if (range) out.wanted = stable(versions).filter((v) => pySatisfies(v, range)).at(-1) ?? null;
    } else if (eco === "cargo") {
      const n = name.toLowerCase();
      const p = n.length === 1 ? `1/${n}` : n.length === 2 ? `2/${n}` : n.length === 3 ? `3/${n[0]}/${n}` : `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
      const r = await http(`https://index.crates.io/${p}`);
      if (!r.ok) return { ...out, error: r.status === 404 ? "not on crates.io (a path or git dependency)" : r.error };
      // The sparse index is one JSON object per line.
      for (const line of String(r.text ?? "").split("\n")) {
        try {
          const j = JSON.parse(line);
          if (!j.yanked) versions.push(j.vers);
        } catch {}
      }
      if (r.json?.vers && !r.json.yanked) versions.push(r.json.vers);
      out.latest = stable(versions).at(-1) ?? null;
      if (range) out.wanted = maxSatisfying(versions, cargoRange(range));
    } else if (eco === "go") {
      const r = await http(`https://proxy.golang.org/${goEscape(name)}/@v/list`);
      if (!r.ok) return { ...out, error: r.status === 404 || r.status === 410 ? "not on proxy.golang.org (private, or replaced locally)" : r.error };
      versions = String(r.text ?? "").split("\n").filter(Boolean);
      out.latest = stable(versions).at(-1) ?? null;
      if (!out.latest) {
        const l = await http(`https://proxy.golang.org/${goEscape(name)}/@latest`);
        out.latest = l.json?.Version ?? null;
      }
      out.wanted = range ?? null; // go.mod pins one version; there is no range to move within
    } else return { ...out, error: `no registry for ${eco}` };
    const sorted = stable(versions);
    return { ...out, ok: true, count: versions.length, recent: sorted.slice(-8).reverse() };
  }

  const fixedFrom = (range) => {
    // "<4.17.5" or ">=2.0.0 <2.3.1": the first version outside each alternative's upper bound.
    const fixes = String(range).split("||").map((p) => /<\s*([\dv][^\s,]*)\s*$/.exec(p.trim())?.[1] ?? (/<=\s*([\dv][^\s,]*)\s*$/.exec(p.trim()) ? `after ${/<=\s*([\dv][^\s,]*)\s*$/.exec(p.trim())[1]}` : null));
    const real = fixes.filter(Boolean);
    return real.length ? [...new Set(real)].join(" or ") : null;
  };

  /**
   * Known advisories for installed packages. `pkgs` is [{name, version}]. Never throws:
   * {ok, source, checked, advisories:[{name, version, severity, title, id, url, vulnerable, fixedIn}], error, note}.
   */
  async function advisories(eco, pkgs) {
    if (!pkgs.length) return { ok: true, source: null, checked: 0, advisories: [] };
    const found = [];
    if (eco === "npm") {
      const body = {};
      for (const p of pkgs) if (parseVersion(p.version)) (body[p.name] ??= []).includes(p.version) || body[p.name].push(p.version);
      const names = Object.keys(body);
      for (let i = 0; i < names.length; i += 400) {
        const r = await http("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", { method: "POST", body: Object.fromEntries(names.slice(i, i + 400).map((n) => [n, body[n]])), timeoutMs: 30_000 });
        if (!r.ok || !r.json) return { ok: false, source: "registry.npmjs.org advisories", checked: 0, advisories: [], error: r.error ?? "unexpected answer" };
        for (const [name, list] of Object.entries(r.json))
          for (const a of list)
            for (const version of body[name] ?? []) {
              if (satisfies(version, a.vulnerable_versions) === false) continue;
              found.push({ name, version, severity: a.severity ?? "unknown", title: String(a.title ?? "").slice(0, 160), id: /GHSA-[\w-]+/.exec(a.url ?? "")?.[0] ?? String(a.id), url: a.url, vulnerable: a.vulnerable_versions, fixedIn: fixedFrom(a.vulnerable_versions) });
            }
      }
      return { ok: true, source: "registry.npmjs.org advisories", checked: names.length, advisories: found };
    }
    if (eco === "python") {
      const list = pkgs.slice(0, 300);
      let failed = 0;
      let lastError = null;
      await pool(list, 8, async (p) => {
        const r = await http(`https://pypi.org/pypi/${encodeURIComponent(p.name)}/${encodeURIComponent(p.version)}/json`);
        if (!r.ok) {
          if (r.status !== 404) {
            failed++;
            lastError = r.error;
          }
          return;
        }
        for (const v of r.json?.vulnerabilities ?? []) {
          if (v.withdrawn) continue;
          const ghsa = [v.id, ...(v.aliases ?? [])].find((x) => /^GHSA-/.test(x));
          const cve = [v.id, ...(v.aliases ?? [])].find((x) => /^CVE-/.test(x));
          found.push({ name: p.name, version: p.version, severity: "unknown", title: String(v.summary || v.details || "").replace(/\s+/g, " ").slice(0, 160), id: cve ?? ghsa ?? v.id, aliases: [v.id, ...(v.aliases ?? [])].slice(0, 4), url: v.link, vulnerable: null, fixedIn: (v.fixed_in ?? []).join(" or ") || null });
        }
      });
      if (failed === list.length) return { ok: false, source: "pypi.org", checked: 0, advisories: [], error: lastError };
      // PyPI lists one entry per database (PYSEC, GHSA) for the same flaw: keep one per package and CVE.
      const seen = new Set();
      const unique = found.filter((a) => !seen.has(`${a.name} ${a.id}`) && seen.add(`${a.name} ${a.id}`));
      return { ok: true, source: "pypi.org", checked: list.length - failed, advisories: unique, note: [pkgs.length > list.length ? `only the first ${list.length} of ${pkgs.length} packages were checked` : null, "PyPI gives no severity; open the advisory for it"].filter(Boolean).join("; ") };
    }
    // Cargo and Go: OSV. One batch query gives advisory ids per package; each advisory is then read once.
    const ecosystem = eco === "cargo" ? "crates.io" : "Go";
    const list = pkgs.slice(0, 900);
    const r = await http(`${osvUrl}/v1/querybatch`, { method: "POST", body: { queries: list.map((p) => ({ package: { name: p.name, ecosystem }, version: p.version.replace(/^v/, "") })) }, timeoutMs: 30_000 });
    if (!r.ok || !r.json?.results) return { ok: false, source: "osv.dev", checked: 0, advisories: [], error: r.error ?? "unexpected answer" };
    const hits = [];
    r.json.results.forEach((res, i) => (res.vulns ?? []).forEach((v) => hits.push({ pkg: list[i], id: v.id })));
    const ids = [...new Set(hits.map((h) => h.id))].slice(0, 40);
    const details = new Map();
    await pool(ids, 6, async (id) => {
      const d = await http(`${osvUrl}/v1/vulns/${encodeURIComponent(id)}`);
      if (d.ok && d.json) details.set(id, d.json);
    });
    for (const h of hits) {
      const d = details.get(h.id);
      if (!d) {
        found.push({ name: h.pkg.name, version: h.pkg.version, severity: "unknown", title: "", id: h.id, url: `https://osv.dev/vulnerability/${h.id}`, vulnerable: null, fixedIn: null });
        continue;
      }
      if (d.withdrawn) continue;
      const aff = (d.affected ?? []).filter((a) => a.package?.name === h.pkg.name);
      const events = aff.flatMap((a) => (a.ranges ?? []).flatMap((x) => x.events ?? []));
      const fixed = [...new Set(events.map((e) => e.fixed).filter(Boolean))];
      const intro = events.map((e) => e.introduced).filter((x) => x && x !== "0");
      const sev = String(d.database_specific?.severity ?? aff[0]?.database_specific?.severity ?? "unknown").toLowerCase();
      found.push({ name: h.pkg.name, version: h.pkg.version, severity: sev === "medium" ? "moderate" : sev, title: String(d.summary || d.details || "").replace(/\s+/g, " ").slice(0, 160), id: (d.aliases ?? []).find((x) => /^CVE-/.test(x)) ?? d.id, aliases: [d.id, ...(d.aliases ?? [])].slice(0, 4), url: `https://osv.dev/vulnerability/${d.id}`, vulnerable: fixed.length ? `${intro.length ? ">=" + intro[0] + " " : ""}<${fixed.at(-1)}` : null, fixedIn: fixed.join(" or ") || null });
    }
    const seen = new Set();
    const unique = found.filter((a) => !seen.has(`${a.name} ${a.id}`) && seen.add(`${a.name} ${a.id}`));
    return { ok: true, source: "osv.dev", checked: list.length, advisories: unique, note: hits.length && ids.length < new Set(hits.map((h) => h.id)).size ? "more than 40 advisories: the rest have an id only" : undefined };
  }

  return { http, registry, advisories };
}
