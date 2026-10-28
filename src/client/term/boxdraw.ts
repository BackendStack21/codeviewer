// Procedural rendering of box-drawing (U+2500–257F) and block elements (U+2580–259F).
// Drawing these from geometry instead of font glyphs gives seamless, pixel-exact borders.

// For U+2500.. : four digits = up, right, down, left weights (0 none, 1 light, 2 heavy, 3 double).
// "." marks characters left to the font (dashed lines, diagonals).
// prettier-ignore
const LINES = [
  "0101","0202","1010","2020",".",".",".",".",".",".",".",".","0110","0210","0120","0220",
  "0011","0012","0021","0022","1100","1200","2100","2200","1001","1002","2001","2002","1110","1210","2110","1120",
  "2120","2210","1220","2220","1011","1012","2011","1021","2021","2012","1022","2022","0111","0112","0211","0212",
  "0121","0122","0221","0222","1101","1102","1201","1202","2101","2102","2201","2202","1111","1112","1211","1212",
  "2111","1121","2121","2112","2211","1122","1221","2212","1222","2122","2221","2222",".",".",".",".",
  "0303","3030","0310","0130","0330","0013","0031","0033","1300","3100","3300","1003","3001","3003","1310","3130",
  "3330","1013","3031","3033","0313","0131","0333","1303","3101","3303","1313","3131","3333","r","r","r",
  "r",".",".",".","0001","1000","0100","0010","0002","2000","0200","0020","0201","1020","0102","2010",
];

export function isProcedural(cp: number): boolean {
  if (cp >= 0x2500 && cp <= 0x257f) return LINES[cp - 0x2500] !== ".";
  return cp >= 0x2580 && cp <= 0x259f;
}

/**
 * Draws the glyph into the cell at (x, y) with size (w, h) in device pixels.
 * The caller has set ctx.fillStyle / strokeStyle to the foreground color.
 */
export function drawProcedural(ctx: CanvasRenderingContext2D, cp: number, x: number, y: number, w: number, h: number, dpr: number) {
  if (cp >= 0x2580) return drawBlock(ctx, cp, x, y, w, h);
  const spec = LINES[cp - 0x2500]!;
  const light = Math.max(1, Math.round(dpr));
  const heavy = light * 2;
  const cx = x + Math.floor((w - light) / 2);
  const cy = y + Math.floor((h - light) / 2);

  if (spec === "r") {
    // Rounded corners ╭ ╮ ╯ ╰
    const r = Math.min(w, h) / 2;
    const mx = cx + light / 2;
    const my = cy + light / 2;
    ctx.save();
    ctx.lineWidth = light;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.beginPath();
    switch (cp) {
      case 0x256d: ctx.moveTo(mx, y + h); ctx.arcTo(mx, my, x + w, my, r); ctx.lineTo(x + w, my); break;
      case 0x256e: ctx.moveTo(x, my); ctx.arcTo(mx, my, mx, y + h, r); ctx.lineTo(mx, y + h); break;
      case 0x256f: ctx.moveTo(mx, y); ctx.arcTo(mx, my, x, my, r); ctx.lineTo(x, my); break;
      case 0x2570: ctx.moveTo(mx, y); ctx.arcTo(mx, my, x + w, my, r); ctx.lineTo(x + w, my); break;
    }
    ctx.stroke();
    ctx.restore();
    return;
  }

  const [up, right, down, left] = [...spec].map(Number) as [number, number, number, number];
  const gap = light;
  const thick = (wt: number) => (wt === 2 ? heavy : light);
  const off = (wt: number) => (wt === 2 ? Math.floor((heavy - light) / 2) : 0);
  // Extents of the center junction so that segments meet without gaps.
  const hasDouble = up === 3 || right === 3 || down === 3 || left === 3;
  const vMax = Math.max(up === 2 || down === 2 ? heavy : light, hasDouble ? light * 3 : 0);
  const hMax = Math.max(left === 2 || right === 2 ? heavy : light, hasDouble ? light * 3 : 0);
  const jx0 = cx - Math.floor((vMax - light) / 2);
  const jy0 = cy - Math.floor((hMax - light) / 2);

  const vert = (wt: number, y0: number, y1: number) => {
    if (wt === 3) {
      ctx.fillRect(cx - gap, y0, light, y1 - y0);
      ctx.fillRect(cx + gap, y0, light, y1 - y0);
    } else ctx.fillRect(cx - off(wt), y0, thick(wt), y1 - y0);
  };
  const horiz = (wt: number, x0: number, x1: number) => {
    if (wt === 3) {
      ctx.fillRect(x0, cy - gap, x1 - x0, light);
      ctx.fillRect(x0, cy + gap, x1 - x0, light);
    } else ctx.fillRect(x0, cy - off(wt), x1 - x0, thick(wt));
  };
  if (up) vert(up, y, jy0 + hMax);
  if (down) vert(down, jy0, y + h);
  if (left) horiz(left, x, jx0 + vMax);
  if (right) horiz(right, jx0, x + w);
}

function drawBlock(ctx: CanvasRenderingContext2D, cp: number, x: number, y: number, w: number, h: number) {
  const rect = (fx: number, fy: number, fw: number, fh: number) =>
    ctx.fillRect(x + Math.round(w * fx), y + Math.round(h * fy), Math.round(w * (fx + fw)) - Math.round(w * fx), Math.round(h * (fy + fh)) - Math.round(h * fy));
  if (cp === 0x2580) return rect(0, 0, 1, 0.5);
  if (cp >= 0x2581 && cp <= 0x2588) {
    const f = (cp - 0x2580) / 8;
    return rect(0, 1 - f, 1, f);
  }
  if (cp >= 0x2589 && cp <= 0x258f) {
    const f = (0x2590 - cp) / 8;
    return rect(0, 0, f, 1);
  }
  if (cp === 0x2590) return rect(0.5, 0, 0.5, 1);
  if (cp >= 0x2591 && cp <= 0x2593) {
    ctx.save();
    ctx.globalAlpha *= (cp - 0x2590) * 0.25;
    rect(0, 0, 1, 1);
    ctx.restore();
    return;
  }
  if (cp === 0x2594) return rect(0, 0, 1, 1 / 8);
  if (cp === 0x2595) return rect(7 / 8, 0, 1 / 8, 1);
  // Quadrants: bit 1 = UL, 2 = UR, 4 = LL, 8 = LR
  const Q = [4, 8, 1, 1 | 4 | 8, 1 | 8, 1 | 2 | 4, 1 | 2 | 8, 2, 2 | 4, 2 | 4 | 8][cp - 0x2596] ?? 0;
  if (Q & 1) rect(0, 0, 0.5, 0.5);
  if (Q & 2) rect(0.5, 0, 0.5, 0.5);
  if (Q & 4) rect(0, 0.5, 0.5, 0.5);
  if (Q & 8) rect(0.5, 0.5, 0.5, 0.5);
}
