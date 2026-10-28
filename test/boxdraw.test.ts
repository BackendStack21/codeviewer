import { describe, expect, test } from "bun:test";
import { drawProcedural, isProcedural } from "../src/client/term/boxdraw.ts";

type Op = [string, ...number[]];

function fakeCtx() {
  const ops: Op[] = [];
  const stack: number[] = [];
  const ctx = {
    fillStyle: "#fff",
    strokeStyle: "",
    lineWidth: 0,
    globalAlpha: 1,
    save: () => (stack.push(ctx.globalAlpha), ops.push(["save"])),
    restore: () => (ctx.globalAlpha = stack.pop()!, ops.push(["restore"])),
    beginPath: () => ops.push(["begin"]),
    stroke: () => ops.push(["stroke"]),
    moveTo: (x: number, y: number) => ops.push(["moveTo", x, y]),
    lineTo: (x: number, y: number) => ops.push(["lineTo", x, y]),
    arcTo: (...a: number[]) => ops.push(["arcTo", ...a]),
    fillRect: (x: number, y: number, w: number, h: number) => ops.push(["rect", x, y, w, h]),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, raw: ctx, ops };
}

const draw = (cp: number, w = 10, h = 20, dpr = 1) => {
  const f = fakeCtx();
  drawProcedural(f.ctx, cp, 0, 0, w, h, dpr);
  return f;
};

describe("boxdraw: isProcedural", () => {
  test("covers lines and blocks, excludes dashed/diagonals and other ranges", () => {
    expect(isProcedural(0x2500)).toBe(true); // ─
    expect(isProcedural(0x254c)).toBe(false); // dashed
    expect(isProcedural(0x2571)).toBe(false); // diagonal
    expect(isProcedural(0x256d)).toBe(true); // rounded
    expect(isProcedural(0x2580)).toBe(true);
    expect(isProcedural(0x259f)).toBe(true);
    expect(isProcedural(0x25a0)).toBe(false);
    expect(isProcedural(0x41)).toBe(false);
  });
});

describe("boxdraw: lines", () => {
  test("light horizontal is two arms overlapping at the center, spanning the cell", () => {
    expect(draw(0x2500).ops).toEqual([["rect", 0, 9, 5, 1], ["rect", 4, 9, 6, 1]]);
  });

  test("light vertical", () => {
    expect(draw(0x2502).ops).toEqual([["rect", 4, 0, 1, 10], ["rect", 4, 9, 1, 11]]);
  });

  test("heavy line is twice as thick", () => {
    expect(draw(0x2501).ops).toEqual([["rect", 0, 9, 5, 2], ["rect", 4, 9, 6, 2]]);
  });

  test("dpr scales thickness", () => {
    const { ops } = draw(0x2502, 10, 20, 2);
    expect(ops[0]![3]).toBe(2);
  });

  test("corner draws two segments that meet", () => {
    expect(draw(0x250c).ops).toEqual([["rect", 4, 9, 1, 11], ["rect", 4, 9, 6, 1]]); // ┌
  });

  test("cross draws four segments", () => {
    expect(draw(0x253c).ops.length).toBe(4);
  });

  test("double lines draw two parallel rects per arm", () => {
    expect(draw(0x2550).ops).toEqual([["rect", 0, 8, 6, 1], ["rect", 0, 10, 6, 1], ["rect", 3, 8, 7, 1], ["rect", 3, 10, 7, 1]]);
    expect(draw(0x2551).ops.length).toBe(4);
  });

  test("mixed heavy/light and half lines", () => {
    expect(draw(0x257a).ops).toEqual([["rect", 4, 9, 6, 2]]); // heavy right
    expect(draw(0x2574).ops.length).toBe(1); // light left
    expect(draw(0x2578).ops.length).toBe(1); // heavy left
    expect(draw(0x257c).ops).toEqual([["rect", 0, 9, 5, 1], ["rect", 4, 9, 6, 2]]); // light left, heavy right
  });

  test("rounded corners stroke an arc with the foreground color", () => {
    for (const cp of [0x256d, 0x256e, 0x256f, 0x2570]) {
      const { ops, raw } = draw(cp);
      expect(ops[0]![0]).toBe("save");
      expect(ops.some((o) => o[0] === "arcTo")).toBe(true);
      expect(ops.some((o) => o[0] === "stroke")).toBe(true);
      expect(ops.at(-1)![0]).toBe("restore");
      expect(raw.strokeStyle).toBe("#fff");
    }
  });
});

describe("boxdraw: blocks", () => {
  test("half blocks", () => {
    expect(draw(0x2580).ops).toEqual([["rect", 0, 0, 10, 10]]);
    expect(draw(0x2584).ops).toEqual([["rect", 0, 10, 10, 10]]);
    expect(draw(0x258c).ops).toEqual([["rect", 0, 0, 5, 20]]);
    expect(draw(0x2590).ops).toEqual([["rect", 5, 0, 5, 20]]);
  });

  test("full block and eighths", () => {
    expect(draw(0x2588).ops).toEqual([["rect", 0, 0, 10, 20]]);
    const low = draw(0x2581, 8, 16).ops[0]!;
    expect(low.slice(1)).toEqual([0, 14, 8, 2]);
    const left = draw(0x258f, 8, 16).ops[0]!;
    expect(left.slice(1)).toEqual([0, 0, 1, 16]);
  });

  test("shades use alpha and restore it", () => {
    const f = fakeCtx();
    const alphas: number[] = [];
    const orig = f.raw.fillRect;
    f.raw.fillRect = (...a: [number, number, number, number]) => {
      alphas.push(f.raw.globalAlpha);
      orig(...a);
    };
    for (const cp of [0x2591, 0x2592, 0x2593]) drawProcedural(f.ctx, cp, 0, 0, 10, 20, 1);
    expect(alphas).toEqual([0.25, 0.5, 0.75]);
    expect(f.raw.globalAlpha).toBe(1);
  });

  test("upper and right eighths", () => {
    expect(draw(0x2594, 8, 16).ops[0]!.slice(1)).toEqual([0, 0, 8, 2]);
    expect(draw(0x2595, 8, 16).ops[0]!.slice(1)).toEqual([7, 0, 1, 16]);
  });

  test("quadrants", () => {
    expect(draw(0x2596).ops).toEqual([["rect", 0, 10, 5, 10]]); // lower left
    expect(draw(0x2597).ops).toEqual([["rect", 5, 10, 5, 10]]); // lower right
    expect(draw(0x2598).ops).toEqual([["rect", 0, 0, 5, 10]]); // upper left
    expect(draw(0x259b).ops.length).toBe(3); // UL+UR+LL
    expect(draw(0x259f).ops.length).toBe(3); // UR+LL+LR
    expect(draw(0x259a).ops.length).toBe(2); // UL+LR
    expect(draw(0x259e).ops.length).toBe(2); // UR+LL
    expect(draw(0x259c).ops.length).toBe(3);
    expect(draw(0x2599).ops.length).toBe(3);
    expect(draw(0x259d).ops).toEqual([["rect", 5, 0, 5, 10]]);
  });
});
