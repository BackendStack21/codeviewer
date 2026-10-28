// codeviewer.21no.de: live release data, platform detection, copy buttons, tabs.
//
// Nothing about a release is baked into the page: the latest release (version, file names,
// sizes, SHA-256 digests) is read from GitHub's API here. Without JavaScript, or if the API
// can't be reached, every download link already points at the GitHub "latest release" page.
(() => {
  const { repo, platforms } = JSON.parse(document.getElementById("platforms").textContent);
  const byId = Object.fromEntries(platforms.map((p) => [p.id, p]));
  const API = `https://api.github.com/repos/${repo}/releases/latest`;
  const CACHE = "cv:latest-release";

  // ── verification tabs ──
  const tabs = [...document.querySelectorAll("[data-tab]")];
  function showTab(name) {
    for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.tab === name));
    for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== name;
  }
  for (const t of tabs) t.addEventListener("click", () => showTab(t.dataset.tab));

  const COPY_ICON = document.querySelector(".copy svg") ? document.querySelector(".copy svg").outerHTML : "";

  // ── which build is this visitor's ──
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  const ua = navigator.userAgent;
  const isLinux = /linux/i.test(platform) && !/android/i.test(ua);
  const isMac = /mac/i.test(platform);
  let preferred = isLinux ? (/aarch64|arm64/i.test(ua) ? "linux-arm64" : "linux-x64") : "macos-arm64";

  // ── live release data ──
  let release = null; // { tag, published, assets: { [id]: { name, url, size, sha256 } }, names: Set }

  const fmtSize = (n) => (n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  function parse(rel) {
    const assets = {};
    for (const a of rel.assets || []) {
      const p = platforms.find((x) => a.name.endsWith(x.suffix) && !assets[x.id]);
      if (p) assets[p.id] = { name: a.name, url: a.browser_download_url, size: a.size, sha256: (a.digest || "").replace(/^sha256:/, "") };
    }
    return { tag: rel.tag_name, published: rel.published_at, assets, names: new Set((rel.assets || []).map((a) => a.name)) };
  }

  async function load() {
    try {
      const cached = JSON.parse(sessionStorage.getItem(CACHE) || "null");
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.rel;
    } catch {}
    const res = await fetch(API, { headers: { accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const rel = await res.json();
    try {
      sessionStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), rel }));
    } catch {}
    return rel;
  }

  function fill() {
    const r = release;
    // Download table
    for (const tr of document.querySelectorAll("tr[data-asset]")) {
      const a = r.assets[tr.dataset.asset];
      if (!a) continue;
      const link = tr.querySelector("[data-link]");
      link.href = a.url;
      link.textContent = a.name;
      tr.querySelector("[data-size]").textContent = fmtSize(a.size);
      const hash = tr.querySelector("[data-hash]");
      if (a.sha256) {
        const b = document.createElement("button");
        b.className = "sha";
        b.type = "button";
        b.title = "Copy SHA-256";
        b.dataset.copy = a.sha256;
        b.innerHTML = `<code>${a.sha256.slice(0, 16)}…${a.sha256.slice(-8)}</code>${COPY_ICON}`;
        hash.replaceWith(b);
      }
    }
    document.getElementById("release-line").textContent = `Latest: ${r.tag}, released ${fmtDate(r.published)}.`;
    // Inline names, then command templates
    for (const el of document.querySelectorAll("[data-name]")) {
      const a = r.assets[el.dataset.name];
      if (a) el.textContent = a.name;
    }
    for (const box of document.querySelectorAll("[data-template]")) {
      let missing = false;
      const text = box.dataset.template
        .replace(/\{url:([\w-]+)\}/g, (_, id) => (r.assets[id] ? r.assets[id].url : ((missing = true), "")))
        .replace(/\{name:([\w-]+)\}/g, (_, id) => (r.assets[id] ? r.assets[id].name : ((missing = true), "")))
        .replace(/\{tag\}/g, r.tag);
      if (missing) continue;
      const lines = text.split("\n");
      const codeEl = box.querySelector("code");
      codeEl.textContent = "";
      lines.forEach((l, i) => {
        if (i) codeEl.append("\n");
        if (l.startsWith("#")) {
          const c = document.createElement("span");
          c.className = "c";
          c.textContent = `# ${l.slice(1).trim()}`;
          codeEl.append(c);
        } else codeEl.append(l);
      });
      box.querySelector(".copy").dataset.copy = lines.filter((l) => !l.startsWith("#")).join("\n");
    }
    // Steps that need an asset this release doesn't have (e.g. an unsigned release)
    for (const el of document.querySelectorAll("[data-needs]")) el.hidden = !r.names.has(el.dataset.needs);
    choose(preferred);
  }

  // ── primary button ──
  const btn = document.getElementById("dl-primary");
  const osLabel = document.getElementById("dl-os");
  const detail = document.getElementById("dl-detail");
  function choose(id) {
    preferred = id;
    const p = byId[id];
    if (!p) return;
    osLabel.textContent = p.os === "macos" ? "macOS" : "Linux";
    detail.textContent = p.detail;
    const a = release && release.assets[id];
    if (a) btn.href = a.url;
    showTab(p.os);
  }
  choose(preferred);
  // Chromium reports the CPU architecture; Safari doesn't (and most Macs are Apple silicon).
  if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    navigator.userAgentData
      .getHighEntropyValues(["architecture"])
      .then((v) => {
        if (isMac && v.architecture === "x86") choose("macos-x64");
        if (isLinux) choose(v.architecture === "arm" ? "linux-arm64" : "linux-x64");
      })
      .catch(() => {});
  }

  load()
    .then((rel) => {
      release = parse(rel);
      fill();
    })
    .catch(() => {
      document.getElementById("release-line").textContent = "Couldn't load the release details right now; the links open the latest release on GitHub.";
    });

  // ── copy buttons ──
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    navigator.clipboard.writeText(b.dataset.copy).then(() => {
      b.classList.add("copied");
      setTimeout(() => b.classList.remove("copied"), 1400);
    });
  });

})();
