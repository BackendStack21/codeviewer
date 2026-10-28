// codeviewer.21no.de: platform detection for the download button, copy buttons, tabs.
// The page works without this script (every link is a plain link).
(() => {
  const downloads = JSON.parse(document.getElementById("downloads").textContent);
  const byId = Object.fromEntries(downloads.map((d) => [d.id, d]));
  const btn = document.getElementById("dl-primary");
  const osLabel = document.getElementById("dl-os");
  const detail = document.getElementById("dl-detail");

  const choose = (id) => {
    const d = byId[id];
    if (!d) return;
    btn.href = d.url;
    osLabel.textContent = d.os === "macos" ? "macOS" : "Linux";
    detail.textContent = d.detail;
    showTab(d.os);
  };

  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  const ua = navigator.userAgent;
  const isLinux = /linux/i.test(platform) && !/android/i.test(ua);
  const isMac = /mac/i.test(platform);
  if (isLinux) choose(/aarch64|arm64/i.test(ua) ? "linux-arm64" : "linux-x64");
  else if (isMac) choose("macos-arm64");
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

  // Copy buttons (hashes and commands)
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    navigator.clipboard.writeText(b.dataset.copy).then(() => {
      b.classList.add("copied");
      setTimeout(() => b.classList.remove("copied"), 1400);
    });
  });

  // Verification tabs
  const tabs = [...document.querySelectorAll("[data-tab]")];
  function showTab(name) {
    for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.tab === name));
    for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== name;
  }
  for (const t of tabs) t.addEventListener("click", () => showTab(t.dataset.tab));
})();
