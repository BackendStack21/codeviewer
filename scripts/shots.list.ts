// The landing page's screenshots, taken by scripts/shots.ts in the demo repo (scripts/demo-repo.ts).
// Each step is the body of an async function run in the page; the helpers ($, row, cmd, mod,
// clickLine, rect…) are defined in scripts/shots.ts. `crop` returns the rectangle to keep.

export interface Step {
  js: string;
  wait?: number;
}
export interface Shot {
  name: string;
  out?: string;
  tabs?: string[];
  active?: string;
  layout?: Record<string, unknown>;
  term?: string[];
  steps: Step[];
  crop?: string;
}

const s = (js: string, wait = 300): Step => ({ js: `${js}\nreturn 1;`, wait });

export const SHOTS: Shot[] = [
  {
    // The hero: explorer, a changed file with blame, and an agent-style terminal session.
    name: "hero",
    out: "screenshot",
    tabs: ["src/queue.ts", "src/cache.ts", "src/router.ts"],
    active: "src/router.ts",
    layout: { panel: true, panelSize: { bottom: 250, right: 560 } },
    term: ["git log --oneline --graph --decorate -6", "git status --short"],
    steps: [s(`await expand('src');`), s(`await clickLine(17);`, 600)],
  },
  {
    name: "explorer",
    tabs: ["src/router.ts"],
    steps: [
      s(`await expand('src', 'docs');`),
      s(`const r = await row('tsconfig.json'); const b = r.getBoundingClientRect();
         r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 60, clientY: b.bottom - 4 }));`),
    ],
    crop: `const m = visible('.ctx-menu').getBoundingClientRect(); const s = visible('.sidebar').getBoundingClientRect(); return box(0, 0, Math.round(Math.max(s.right, m.right + 12)), Math.round(m.bottom + 16));`,
  },
  {
    name: "quick-open",
    tabs: ["src/router.ts"],
    steps: [s(`mod('p'); const i = await until(() => visible('.palette-input')); typeInto(i, 'ca');`, 500)],
    crop: `return rect('.palette', 0);`,
  },
  {
    name: "commands",
    tabs: ["src/router.ts"],
    steps: [s(`mod('p', { shiftKey: true }); const i = await until(() => visible('.palette-input')); typeInto(i, '>git');`, 500)],
    crop: `return rect('.palette', 0);`,
  },
  {
    name: "symbols",
    tabs: ["src/queue.ts"],
    steps: [s(`mod('o', { shiftKey: true }); await until(() => visible('.pal-item .sym-kind'));`, 500)],
    crop: `return rect('.palette', 0);`,
  },
  {
    name: "history",
    tabs: ["src/cache.ts"],
    steps: [s(`await cmd('Git: File History'); await until(() => visible('.pal-item .gbadge'));`, 500)],
    crop: `return rect('.palette', 0);`,
  },
  {
    name: "search",
    tabs: ["src/cache.ts"],
    steps: [
      s(`mod('f', { shiftKey: true }); const q = await until(() => visible('.sv-query')); typeInto(q, 'expires'); key('Enter', {}, q);`, 1200),
      s(`const r = await until(() => $$('.sv-row')[1]); r.click();`, 700),
    ],
    crop: `return box(0, 0, 1280, Math.round(lineEl(21).getBoundingClientRect().bottom + 1));`,
  },
  {
    name: "changes",
    tabs: [],
    steps: [
      s(`mod('g', { shiftKey: true }); await until(() => visible('.ch-row'));`, 600),
      s(`const r = $$('.ch-row').find((r) => r.textContent.includes('cache.ts')); r.click();`, 900),
      s(`await until(() => visible('.diffview .dr-add')); key('F5', { altKey: true }, document.body);`, 600),
    ],
    crop: `return box(0, 0, 1280, 640);`,
  },
  {
    name: "peek",
    tabs: ["src/router.ts"],
    steps: [
      s(`const g = await until(() => visible('.code .ln[data-n="15"] .g')); const r = g.getBoundingClientRect();
         g.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.right - 3, clientY: r.top + 4 }));`, 700),
    ],
    crop: `const p = (await until(() => visible('.peek'))).getBoundingClientRect(); const c = visible('.editor').getBoundingClientRect();
           const top = lineEl(12).getBoundingClientRect().top - 6, bottom = lineEl(26).getBoundingClientRect().bottom + 1;
           return box(c.left, top, Math.round(p.right - c.left + 16), Math.round(bottom - top));`,
  },
  {
    name: "blame",
    tabs: ["src/cache.ts"],
    steps: [s(`await clickLine(27);`, 900)],
    crop: `const b = (await until(() => visible('.ln.active .blame'))).getBoundingClientRect(); const c = visible('.editor').getBoundingClientRect();
           const top = lineEl(18).getBoundingClientRect().top - 6, bottom = lineEl(27).getBoundingClientRect().bottom + 1;
           return box(c.left, top, Math.round(b.right - c.left + 24), Math.round(bottom - top));`,
  },
  {
    name: "markdown",
    tabs: ["README.md"],
    steps: [s(`await until(() => visible('.md-doc table')); visible('.md-view').scrollTop = 0;`, 600)],
    crop: `const c = visible('.editor').getBoundingClientRect(); const d = visible('.md-doc').getBoundingClientRect(); return box(Math.round(d.left - 32), c.top + 44, Math.round(d.width + 64), 600);`,
  },
  {
    name: "find",
    tabs: ["src/queue.ts"],
    steps: [
      s(`mod('f'); const i = await until(() => visible('.find-input')); typeInto(i, 'queue');`, 600),
    ],
    crop: `const c = visible('.editor').getBoundingClientRect(); return box(c.left, c.top, c.width, 440);`,
  },
  {
    name: "terminal",
    tabs: ["src/cache.ts"],
    layout: { panel: true, panelSize: { bottom: 420, right: 560 } },
    term: ["git log --oneline --graph --decorate --all", "git diff --stat main", "wc -l src/*.ts"],
    steps: [s(`await clickLine(25);`, 400), s(`await cmd('Insert Reference in Terminal');`, 800)],
    crop: `return rect('.panel', 0);`,
  },
  {
    name: "live",
    tabs: ["src/util/time.ts"],
    layout: { panel: true, panelSize: { bottom: 330, right: 560 } },
    term: [`perl -pi -e 's/ms < 1000/ms < 1_000/; s/toFixed\\(1\\)/toFixed(2)/' src/util/time.ts`],
    steps: [s(`await until(() => visible('.ln.flash'), 6000);`, 50)],
    crop: `const e = visible('.editor').getBoundingClientRect(); return box(e.left, e.top, 860, Math.round(lineEl(7).getBoundingClientRect().bottom + 12 - e.top));`,
  },
  {
    name: "image",
    tabs: ["docs/logo.png"],
    steps: [s(`await until(() => visible('.image-view img')); [...document.querySelectorAll('.img-bar button')].find((b) => b.textContent === '1:1').click();`, 600)],
    crop: `const e = visible('.editor').getBoundingClientRect(); const i = visible('.image-view img').getBoundingClientRect(); const bar = visible('.img-bar').getBoundingClientRect();
           const cx = (i.left + i.right) / 2; return box(Math.round(cx - 300), Math.round(i.top - 48), 600, Math.round(i.height + 96));`,
  },
  {
    // Two terminals in the panel, moved to the right; pinned tabs and an italic preview tab.
    name: "panels",
    tabs: ["src/queue.ts", "src/cache.ts"],
    active: "src/cache.ts",
    layout: { panel: true, panelPos: "right", panelSize: { bottom: 250, right: 560 } },
    term: ["git status --short"],
    steps: [
      s(`await expand('src'); (await row('router.ts')).click();`, 600),
      s(`key('\`', { ctrlKey: true, shiftKey: true, code: 'Backquote' }, document.body);`, 1600),
      s(`const t = $$('.term-input').at(-1); t.focus(); const dt = new DataTransfer(); dt.setData('text/plain', 'ls src');
         t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); key('Enter', {}, t);`, 900),
    ],
  },
  {
    name: "hexdump",
    tabs: ["data/queue.snap"],
    steps: [s(`await until(() => visible('.hexdump'));`, 400)],
    crop: `const e = visible('.editor').getBoundingClientRect(); const d = visible('.binary-view').getBoundingClientRect(); const x = visible('.hexdump').getBoundingClientRect();
           return box(e.left, e.top, Math.round(Math.min(e.width, x.width + 48)), Math.round(Math.min(x.bottom + 16, d.bottom) - e.top));`,
  },
  {
    name: "welcome",
    tabs: [],
    steps: [s(`await until(() => visible('.welcome'));`, 300)],
    crop: `return rect([...visible('.welcome').querySelectorAll('*')].filter((e) => e.offsetParent && e.getBoundingClientRect().width < 900), 40);`,
  },
  {
    // The update dialog, with GitHub's answer stubbed in the page: the shots never go online.
    name: "updates",
    tabs: ["src/router.ts"],
    steps: [
      s(`const real = window.fetch.bind(window); const v = '__VERSION__', next = '__NEXT__';
         window.fetch = (u, o) => String(u).startsWith('/api/update') && !String(u).includes('apply')
           ? Promise.resolve(new Response(JSON.stringify({ current: v, latest: next, available: true, canInstall: true, kind: 'app', notes: 'Release notes from GitHub appear here.', url: 'https://github.com', checkedAt: 0 }), { headers: { 'content-type': 'application/json' } }))
           : real(u, o);
         window.dispatchEvent(new Event('cv-check-updates'));`, 900),
    ],
    crop: `return rect(visible('.upd-overlay:not([hidden]) .upd'), 0);`,
  },
  {
    name: "statusbar",
    tabs: ["src/router.ts"],
    steps: [s(`await clickLine(16);`, 600)],
    crop: `const r = visible('.statusbar').getBoundingClientRect(); const p = $$('.statusbar .status-left > *').at(-1).getBoundingClientRect(); return box(0, r.top, Math.round(p.left - 4), r.height);`,
  },
  {
    name: "help",
    tabs: ["src/router.ts"],
    steps: [s(`mod('/'); await until(() => visible('.upd.help'));`, 500)],
    crop: `const d = visible('.upd.help').getBoundingClientRect(); const git = [...visible('.upd.help').querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim().toUpperCase() === 'GIT').getBoundingClientRect();
           return box(Math.round(d.left), Math.round(d.top), Math.round(d.width), Math.round(git.top - 10 - d.top));`,
  },
];
