// Hand-tuned 16px icons. Files are tinted by language so the tree reads at a glance.

const COLORS: Record<string, string> = {
  ts: "#4b8fe0", tsx: "#4b8fe0", mts: "#4b8fe0", cts: "#4b8fe0", js: "#e6c84d", mjs: "#e6c84d", cjs: "#e6c84d", jsx: "#e6c84d",
  json: "#d9a54a", jsonc: "#d9a54a", lock: "#8b8f99", md: "#5fb3d9", mdx: "#5fb3d9", txt: "#9aa0ab",
  py: "#5a9fd4", rs: "#de7a4f", go: "#4fc3d9", c: "#7f9fd6", h: "#a78bd6", cpp: "#7f9fd6", hpp: "#a78bd6", cc: "#7f9fd6",
  java: "#e0784a", kt: "#a77ae6", swift: "#f0804e", rb: "#e0525a", php: "#8a8fdc", cs: "#69b85a", lua: "#5a7fdc",
  sh: "#7cc36a", bash: "#7cc36a", zsh: "#7cc36a", fish: "#7cc36a", html: "#e8734a", htm: "#e8734a", xml: "#d38a4a",
  css: "#5b8de0", scss: "#d66ba0", less: "#5b8de0", vue: "#4fbf8a", svelte: "#f06a3c", yml: "#c9668a", yaml: "#c9668a",
  toml: "#a8a5a0", ini: "#a8a5a0", env: "#e6c84d", sql: "#e0a64a", zig: "#f0a640", hs: "#9b7fd6", dart: "#4fb5e6",
  png: "#b77fe0", jpg: "#b77fe0", jpeg: "#b77fe0", gif: "#b77fe0", svg: "#e8a03c", webp: "#b77fe0", ico: "#b77fe0",
  avif: "#b77fe0", bmp: "#b77fe0", pdf: "#e05a5a", zip: "#a8a5a0", gz: "#a8a5a0", wasm: "#7f6fe0",
};

const NAMED: Record<string, string> = {
  "package.json": "#7cc36a", "bun.lock": "#f5d0a9", dockerfile: "#4f9fe0", makefile: "#e07a5a", license: "#e0c050",
  "readme.md": "#5fb3d9", ".gitignore": "#e0705a", "tsconfig.json": "#4b8fe0", "cargo.toml": "#de7a4f", "go.mod": "#4fc3d9",
};

export function fileColor(name: string): string {
  const lower = name.toLowerCase();
  if (NAMED[lower]) return NAMED[lower]!;
  const dot = lower.lastIndexOf(".");
  return (dot >= 0 && COLORS[lower.slice(dot + 1)]) || "var(--icon-file)";
}

export function fileIcon(name: string): string {
  const c = fileColor(name);
  return `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.2L13 5.3V13.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-width="1.1"/><path d="M9 1.7V5.5h3.8" fill="none" stroke="${c}" stroke-width="1.1"/></svg>`;
}

export function folderIcon(open: boolean): string {
  return open
    ? `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1V6H4.2a1 1 0 0 0-.95.68L1.5 12z" fill="var(--icon-folder)" fill-opacity=".35"/><path d="M3.3 6.7a1 1 0 0 1 .95-.7h10.4a.6.6 0 0 1 .57.8l-1.9 5.5a1 1 0 0 1-.95.7H2.1a.6.6 0 0 1-.57-.8z" fill="var(--icon-folder)"/></svg>`
    : `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5a1 1 0 0 1 1-1h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="var(--icon-folder)"/></svg>`;
}

export const chevron = `<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const P = (d: string, extra = "") =>
  `<svg viewBox="0 0 16 16" aria-hidden="true" ${extra}><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const icons = {
  close: P("M4 4l8 8M12 4l-8 8"),
  plus: P("M8 3v10M3 8h10"),
  search: P("M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM14 14l-3.5-3.5"),
  terminal: P("M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10h2.5"),
  sidebar: P("M2.5 3h11v10h-11zM6 3v10"),
  panelBottom: P("M2.5 3h11v10h-11zM2.5 9.5h11"),
  panelRight: P("M2.5 3h11v10h-11zM9.5 3v10"),
  maximize: P("M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"),
  restore: P("M6 3v3H3M10 3v3h3M6 13v-3H3M10 13v-3h3"),
  sun: P("M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1"),
  moon: P("M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z"),
  collapse: P("M4 6l4-3 4 3M4 10l4 3 4-3"),
  refresh: P("M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"),
  wrap: P("M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H9M10.5 10.5L9 12l1.5 1.5M2.5 12h4"),
  copy: P("M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3"),
  code: P("M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"),
  image: P("M2.5 3h11v10h-11zM2.5 11l3.5-3.5 3 3 2-2 2.5 2.5M10.5 6.5h.01"),
  branch: P("M5 3v7M5 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5 3a1.5 1.5 0 1 0 0 .01M11 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM11 6c0 3-6 2-6 4"),
  stash: P("M3 5.5h10M3 8.5h10M3 11.5h10"),
  logo: `<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent-2)"/></linearGradient></defs><path d="M12 2l9 5v10l-9 5-9-5V7z" fill="url(#lg)"/><path d="M9.5 9L7 12l2.5 3M14.5 9L17 12l-2.5 3" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};
