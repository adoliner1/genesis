import Phaser from 'phaser';
import { PLAYER_COLORS, T, TILE, type CharKind } from '../shared/protocol';

type Pal = Record<string, string>;

function canvasTex(scene: Phaser.Scene, key: string, w: number, h: number) {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const tex = scene.textures.createCanvas(key, w, h)!;
  return { tex, ctx: tex.getContext() };
}

function paintRows(ctx: CanvasRenderingContext2D, rows: string[], pal: Pal, scale = 1) {
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const c = pal[ch];
      if (!c) return;
      ctx.fillStyle = c;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }),
  );
}

export function fromRows(scene: Phaser.Scene, key: string, rows: string[], pal: Pal) {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const { tex, ctx } = canvasTex(scene, key, w, h);
  paintRows(ctx, rows, pal);
  tex.refresh();
}

function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

function hash(x: number, y: number, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const K = '#140c18';

/** Hooded, light, a quiver of fletchings over the shoulder. H = hood (player color). */
const HERO_ARCHER = [
  '.....kkk....',
  '....kHHHk...',
  '...kHHHHHk..',
  '..kHHHHHHHk.',
  '..kHHssssHk.',
  '..kHsesesk..',
  '..kHssssk...',
  '.fkkHHHHkk..',
  'fqkbbbbbbbk.',
  'kqkbBbbbBbsk',
  'kqkbllllbbkk',
  '.kkbbbbbbk..',
  '..kgk..kgk..',
  '..kdk..kdk..',
  '..kkk..kkk..',
];

/** Plate armor and a plumed great helm. P = plume, T = tabard (player color). */
const HERO_KNIGHT = [
  '....kPPk.....',
  '...kPPPk.....',
  '...kkkkkk....',
  '..kmMMmmmk...',
  '.kmMmmmmmmk..',
  '.kmmkkkkkmk..',
  '.kmmkeekkmk..',
  '.kmmmmmmmmk..',
  'kkMkkkkkkMkk.',
  'kMmkTTTTkmMk.',
  'kmmkTyyTkmmk.',
  '.kkkTTTTkkk..',
  '..kmmkkmmk...',
  '..kmk..kmk...',
  '.kkkk..kkkk..',
];

export const HERO_ROWS: Record<CharKind, string[]> = { archer: HERO_ARCHER, knight: HERO_KNIGHT };

export function heroPalette(k: CharKind, c: string): Pal {
  if (k === 'knight')
    return { k: K, P: c, T: shade(c, 0.7), y: '#ffd23f', m: '#9aa0b4', M: '#dfe4f0', e: '#ff6a3a' };
  return {
    k: K,
    H: shade(c, 0.85),
    s: '#f2c29b',
    e: '#1b1030',
    b: '#4d6a34',
    B: '#35492a',
    l: '#6b4a2a',
    g: '#3a2c1e',
    d: '#2e2438',
    q: '#8a5a2e',
    f: '#f4f0e0',
  };
}

/** Lobby portrait on a plain canvas, no Phaser needed. */
export function drawPortrait(canvas: HTMLCanvasElement, k: CharKind, c: string, scale: number) {
  const rows = HERO_ROWS[k];
  canvas.width = 14 * scale;
  canvas.height = rows.length * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  paintRows(ctx, rows, heroPalette(k, c), scale);
}

const GRUNT = [
  'k..........k',
  'gk........kg',
  'ggkkkkkkkkgg',
  '.kggggggggk.',
  'kggyyggyyggk',
  'kggkyggkyggk',
  'kggggggggggk',
  'kgkwkwwkwkgk',
  '.kggggggggk.',
  '.kGGllllGGk.',
  'kGGGGGGGGGGk',
  '.kGGk..kGGk.',
  '.kkk....kkk.',
];

const ARCHER = [
  '...kkkkkk...',
  '..kwwwwwwk..',
  '.kwwwwwwwwk.',
  '.kwrrwwrrwk.',
  '.kwrrwwrrwk.',
  '.kwwwkkwwwk.',
  '..kwkwkwkk..',
  '...kkkkkk...',
  '.bk.kwwk.kb.',
  'b.kwwwwwwk.b',
  'b..kwkkwk..b',
  'b...kwwk...b',
  '.b.kw..wk.b.',
  '...kw..wk...',
  '...kk..kk...',
];

const BRUTE = [
  '.hh..........hh.',
  '.hhk........khh.',
  '..hkkkkkkkkkkh..',
  '..krrrrrrrrrrk..',
  '.krrrrrrrrrrrrk.',
  '.krryyrrrryyrrk.',
  '.krrykrrrrykrrk.',
  '.krrrrrrrrrrrrk.',
  '..krkwkwwkwkrk..',
  '.kRRRRRRRRRRRRk.',
  'kRRRRRRRRRRRRRRk',
  'kRRkRRRRRRRRkRRk',
  'krrkRRllllRRkrrk',
  '.kk.kRRRRRRk.kk.',
  '....kRRkkRRk....',
  '....kkk..kkk....',
];

const BARREL = [
  '..kkkkkkkk..',
  '.kRooooooRk.',
  'kRoOOOOOOoRk',
  'kRooooooooRk',
  'kkkkkkkkkkkk',
  'kRrrrrrrrrRk',
  'kRyykkyykkRk',
  'kRkyykkyykRk',
  'kRrrrrrrrrRk',
  'kkkkkkkkkkkk',
  'kRrrrrrrrrRk',
  'kRrrrrrrrrRk',
  '.kRrrrrrrRk.',
  '..kkkkkkkk..',
];

const ITEMS: Record<string, { rows: string[]; pal: Pal }> = {
  potion: {
    rows: ['..kkkk..', '..kwwk..', '...kk...', '..krrk..', '.krrwrk.', '.krrrrk.', '.krrrrk.', '..kkkk..'],
    pal: { k: K, w: '#ffd6e0', r: '#e8233f' },
  },
  sigil: {
    rows: ['kkkkkkkk', 'kyykkyyk', 'kykkkkyk', 'kyykkyyk', 'kkykkykk', 'kyykkyyk', 'kykkkkyk', 'kkkkkkkk'],
    pal: { k: '#3a2048', y: '#ffd23f' },
  },
  ricochet: {
    rows: ['..kkkk..', '.kbbwbk.', 'kbbbbwbk', 'kbbbbbbk', 'kBbbbbbk', 'kBBbbbbk', '.kBBbbk.', '..kkkk..'],
    pal: { k: K, w: '#e8f8ff', b: '#3fa9ff', B: '#1d5fb0' },
  },
  heavy: {
    rows: ['..kkkk..', '.kwggggk', 'kwggggGk', 'kgggggGk', 'kgggggGk', 'kggggGGk', '.kGGGGk.', '..kkkk..'],
    pal: { k: K, w: '#e0e0ea', g: '#8a8a9a', G: '#50505e' },
  },
  fang: {
    rows: ['kkkkkkkk', 'kwwwwwwk', '.kwwwwk.', '.kwwwwk.', '..kwwk..', '..kwrk..', '...kr...', '....r...'],
    pal: { k: K, w: '#f4f0e0', r: '#e8233f' },
  },
  boots: {
    rows: ['..kkkk..', '..kbbk..', '..kbbk..', '..kbbk..', '..kbbbk.', '.kbbbbbk', 'kkkkkkkk', '.yy..yy.'],
    pal: { k: K, b: '#9a5a2e', y: '#ffe066' },
  },
  charm: {
    rows: ['...kk...', '..kwwk..', '..kwwk..', '.kkwwkk.', 'kwwwwwwk', '.kkwwkk.', '..kwwk..', '..krrk..'],
    pal: { k: K, w: '#f4f0e0', r: '#e8233f' },
  },
};

export function makePlayerTextures(scene: Phaser.Scene) {
  PLAYER_COLORS.forEach((c, i) => {
    for (const k of ['archer', 'knight'] as const) fromRows(scene, `hero_${k}${i}`, HERO_ROWS[k], heroPalette(k, c));
    fromRows(scene, `shield${i}`, SHIELD, { k: K, m: '#9aa0b4', M: '#dfe4f0', T: c, y: '#ffd23f' });
  });
}

const SHIELD = ['kkkkkkk', 'kMTTTmk', 'kMTyTmk', 'kMTTTmk', 'kMmTmmk', '.kmTmk.', '.kmmmk.', '..kmk..', '...k...'];

export function makeTextures(scene: Phaser.Scene) {
  makePlayerTextures(scene);
  fromRows(scene, 'grunt', GRUNT, { k: K, g: '#6fbf3c', G: '#3f7a2a', y: '#ffe23f', w: '#f4f0e0', l: '#6b3a22' });
  fromRows(scene, 'archer', ARCHER, { k: K, w: '#e8e0c8', r: '#ff3355', b: '#9a6a3a' });
  fromRows(scene, 'brute', BRUTE, { k: K, h: '#e8e0c8', r: '#c2413a', R: '#7a2430', y: '#ffe23f', w: '#f4f0e0', l: '#3a2020' });
  fromRows(scene, 'barrel', BARREL, { k: K, R: '#8a1f24', r: '#c8312e', o: '#d8503a', O: '#f07050', y: '#ffd23f' });
  for (const [k, v] of Object.entries(ITEMS)) fromRows(scene, `item_${k}`, v.rows, v.pal);

  fromRows(scene, 'bow', ['kk...', 'wwk..', '.wwk.', '..wk.', '..wwk', '..wwk', '..wwk', '..wk.', '.wwk.', 'wwk..', 'kk...'], { k: K, w: '#b0783a' });
  fromRows(scene, 'sword', ['...kk.........', '..kyyk.kkkkkk.', 'kbbkyyWwwwwwwk', '..kyyk.kkkkkk.', '...kk.........'], {
    k: K,
    b: '#6b3a22',
    y: '#ffd23f',
    w: '#cfd6e6',
    W: '#ffffff',
  });
  fromRows(scene, 'arrowshot', ['f....k..', '.fwwwwhh', 'f....k..'], { f: '#f4f0e0', w: '#c89050', h: '#dfe4f0', k: '#8a8a9a' });
  fromRows(scene, 'nock', ['f....', '.fwww', 'f....'], { f: '#f4f0e0', w: '#c89050' });
  fromRows(scene, 'trap', ['f.f', '.f.', '.w.', '.w.', 'kwk'], { f: '#f4f0e0', w: '#c89050', k: K });
  fromRows(scene, 'bullet', ['.oyyyw', 'oyyyww', '.oyyyw'], { o: '#ff8a1f', y: '#ffe066', w: '#ffffff' });
  fromRows(scene, 'ebullet', ['.mmmm.', 'mppppm', 'mpwwpm', 'mpwwpm', 'mppppm', '.mmmm.'], { m: '#a01890', p: '#ff4fd8', w: '#ffffff' });
  fromRows(scene, 'flash', ['...w...', '..wyw..', '.wyyyw.', 'wyyWyyw', '.wyyyw.', '..wyw..', '...w...'], { w: '#ffb13b', y: '#ffe066', W: '#ffffff' });
  fromRows(
    scene,
    'cross',
    ['...w...', '...w...', '.......', 'ww.r.ww', '.......', '...w...', '...w...'],
    { w: '#ffffff', r: '#ff3355' },
  );
  fromRows(scene, 'arrow', ['..w..', '.www.', 'wwwww', '.www.', '.www.'], { w: '#ffffff' });

  const glow = canvasTex(scene, 'glow', 64, 64);
  const g = glow.ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  glow.ctx.fillStyle = g;
  glow.ctx.fillRect(0, 0, 64, 64);
  glow.tex.refresh();

  makeBoss(scene);
  makeHazardTextures(scene);
}

function makeBoss(scene: Phaser.Scene) {
  const S = 34;
  const { tex, ctx } = canvasTex(scene, 'boss', S, S);
  const px = (x: number, y: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, 1, 1);
  };
  const cx = 17;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = x - cx + 0.5;
      const robe = y > 13 && Math.abs(dx) < 4 + (y - 13) * 0.55 && y < 32;
      const head = (dx * dx) / 36 + ((y - 10) * (y - 10)) / 30 < 1;
      const horn = (y < 9 && y > 1 && Math.abs(Math.abs(dx) - (10 - y * 0.4)) < 1.3) || (y < 3 && Math.abs(Math.abs(dx) - 9.5) < 1);
      if (robe) {
        const fold = Math.abs(dx) % 4 < 1 ? '#3a1654' : '#5a2280';
        px(x, y, y > 29 && (x + y) % 3 === 0 ? '#2a0e3e' : fold);
      }
      if (horn) px(x, y, '#e8e0c8');
      if (head) px(x, y, '#e8e0c8');
    }
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) px(cx + sx * 3 - (sx < 0 ? 2 : 0) + i, 9 + j, '#140c18');
    px(cx + sx * 3 - (sx < 0 ? 1 : -1), 9, '#ff2e5a');
    px(cx + sx * 3 - (sx < 0 ? 1 : -1), 10, '#ffb13b');
  }
  for (let i = -3; i <= 3; i++) px(cx + i, 14, i % 2 ? '#140c18' : '#f4f0e0');
  for (let i = -3; i <= 3; i++) px(cx + i, 15, '#140c18');
  for (let x = cx - 12; x <= cx + 12; x++) {
    const y = 18 + Math.round(Math.abs(x - cx) * 0.2);
    if (Math.abs(x - cx) > 5) {
      px(x, y, '#5a2280');
      px(x, y + 1, '#3a1654');
    }
  }
  for (const sx of [-1, 1]) {
    px(cx + sx * 13, 19, '#e8e0c8');
    px(cx + sx * 13, 20, '#e8e0c8');
    px(cx + sx * 14, 21, '#e8e0c8');
  }
  for (let i = -2; i <= 2; i++) px(cx + i, 21, i === 0 ? '#ff2e5a' : '#ffd23f');
  outline(ctx, S, S, K);
  tex.refresh();
}

function outline(ctx: CanvasRenderingContext2D, w: number, h: number, color: string) {
  const img = ctx.getImageData(0, 0, w, h);
  const a = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img.data[(y * w + x) * 4 + 3]);
  ctx.fillStyle = color;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (!a(x, y) && (a(x - 1, y) || a(x + 1, y) || a(x, y - 1) || a(x, y + 1))) ctx.fillRect(x, y, 1, 1);
}

function makeHazardTextures(scene: Phaser.Scene) {
  for (let f = 0; f < 3; f++) {
    const { tex, ctx } = canvasTex(scene, `lava${f}`, TILE, TILE);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const v = Math.sin((x + f * 5) * 0.7) + Math.cos((y * 0.9 + f * 3) * 0.8) + hash(x, y, f) * 0.8;
        ctx.fillStyle = v > 1.4 ? '#ffe066' : v > 0.5 ? '#ff8a1f' : v > -0.6 ? '#e8401f' : '#a8201a';
        ctx.fillRect(x, y, 1, 1);
      }
    tex.refresh();
  }
  for (let f = 0; f < 3; f++) {
    const { tex, ctx } = canvasTex(scene, `spk${f}`, TILE, TILE);
    ctx.fillStyle = '#4a4258';
    ctx.fillRect(1, 1, 14, 14);
    ctx.fillStyle = '#2e2838';
    ctx.fillRect(1, 14, 14, 1);
    for (const [sx, sy] of [
      [3, 3],
      [9, 3],
      [6, 8],
      [3, 12],
      [11, 11],
    ]) {
      ctx.fillStyle = '#140c18';
      ctx.fillRect(sx, sy, 3, 2);
      if (f === 1) {
        ctx.fillStyle = '#b8b8c8';
        ctx.fillRect(sx + 1, sy, 1, 1);
      }
      if (f === 2) {
        ctx.fillStyle = '#d8d8e8';
        ctx.fillRect(sx + 1, sy - 3, 1, 4);
        ctx.fillStyle = '#8a8a9a';
        ctx.fillRect(sx, sy - 1, 1, 2);
        ctx.fillRect(sx + 2, sy - 1, 1, 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(sx + 1, sy - 3, 1, 1);
      }
    }
    tex.refresh();
  }
  {
    const { tex, ctx } = canvasTex(scene, 'grate', TILE * 2, TILE * 2);
    ctx.fillStyle = '#6a5a3a';
    for (let i = 1; i < 32; i += 5) {
      ctx.fillRect(i, 1, 2, 30);
      ctx.fillRect(1, i, 30, 2);
    }
    ctx.fillStyle = '#9a8a5a';
    for (let i = 1; i < 32; i += 5) ctx.fillRect(i, 1, 1, 30);
    tex.refresh();
  }
}

/** Renders the static layer of a floor (floor, walls, pits, stairs pit) into a canvas texture. */
export function renderMap(scene: Phaser.Scene, key: string, w: number, h: number, tiles: Uint8Array, seed: number, boss: boolean) {
  const { tex, ctx } = canvasTex(scene, key, w * TILE, h * TILE);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? T.Wall : tiles[y * w + x]);
  const floorBase = boss ? [0x3a, 0x26, 0x3a] : [0x34, 0x2e, 0x40];
  const rgb = (r: number, g: number, b: number) => `rgb(${r | 0},${g | 0},${b | 0})`;

  for (let ty = 0; ty < h; ty++)
    for (let tx = 0; tx < w; tx++) {
      const t = at(tx, ty);
      const ox = tx * TILE;
      const oy = ty * TILE;
      if (t === T.Wall) {
        const below = at(tx, ty + 1);
        if (below !== T.Wall) {
          for (let y = 0; y < TILE; y++)
            for (let x = 0; x < TILE; x++) {
              const row = Math.floor(y / 4);
              const off = row % 2 ? 4 : 0;
              const mortar = y % 4 === 3 || (x + off) % 8 === 7;
              const n = hash(ox + x, oy + y, seed) * 14;
              const [r, g, b] = mortar ? [0x2a, 0x22, 0x33] : [0x5c + n, 0x4e + n, 0x6c + n];
              const dark = y > 12 ? 0.7 : 1;
              ctx.fillStyle = rgb(r * dark, g * dark, b * dark);
              ctx.fillRect(ox + x, oy + y, 1, 1);
            }
          ctx.fillStyle = '#7a6a8c';
          ctx.fillRect(ox, oy, TILE, 1);
        } else {
          for (let y = 0; y < TILE; y++)
            for (let x = 0; x < TILE; x++) {
              const n = hash(ox + x, oy + y, seed + 1) * 10;
              ctx.fillStyle = rgb(0x1c + n, 0x16 + n, 0x24 + n);
              ctx.fillRect(ox + x, oy + y, 1, 1);
            }
          const edges: [number, number, number, number, number, number][] = [
            [0, -1, 0, 0, TILE, 1],
            [-1, 0, 0, 0, 1, TILE],
            [1, 0, TILE - 1, 0, 1, TILE],
          ];
          ctx.fillStyle = '#3a3048';
          for (const [dx, dy, x, y, ew, eh] of edges) if (at(tx + dx, ty + dy) !== T.Wall) ctx.fillRect(ox + x, oy + y, ew, eh);
        }
        continue;
      }
      if (t === T.Pit) {
        ctx.fillStyle = '#050308';
        ctx.fillRect(ox, oy, TILE, TILE);
        if (at(tx, ty - 1) !== T.Pit) {
          for (let y = 0; y < 5; y++) {
            ctx.fillStyle = rgb(0x2a - y * 5, 0x22 - y * 4, 0x33 - y * 6);
            ctx.fillRect(ox, oy + y, TILE, 1);
          }
        }
        for (let y = 0; y < TILE; y++)
          for (let x = 0; x < TILE; x++)
            if (hash(ox + x, oy + y, seed + 7) > 0.97) {
              ctx.fillStyle = '#140e1c';
              ctx.fillRect(ox + x, oy + y, 1, 1);
            }
        ctx.fillStyle = '#6a5a7c';
        if (at(tx - 1, ty) !== T.Pit) ctx.fillRect(ox, oy, 1, TILE);
        if (at(tx + 1, ty) !== T.Pit) ctx.fillRect(ox + TILE - 1, oy, 1, TILE);
        if (at(tx, ty + 1) !== T.Pit) {
          ctx.fillRect(ox, oy + TILE - 2, TILE, 2);
          ctx.fillStyle = '#3a2e48';
          ctx.fillRect(ox, oy + TILE - 3, TILE, 1);
        }
        if (at(tx, ty - 1) !== T.Pit) {
          ctx.fillStyle = '#7a6a8c';
          ctx.fillRect(ox, oy, TILE, 1);
        }
        continue;
      }
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++) {
          const n = hash(ox + x, oy + y, seed + 2);
          const seam = x === 0 || y === 0;
          let f = seam ? 0.82 : 1 + (n - 0.5) * 0.12;
          if (n > 0.985) f = 1.25;
          const tileVar = hash(tx, ty, seed + 3);
          if (tileVar > 0.9 && !seam) f *= 0.92;
          ctx.fillStyle = rgb(floorBase[0] * f, floorBase[1] * f, floorBase[2] * f);
          ctx.fillRect(ox + x, oy + y, 1, 1);
        }
      if (hash(tx, ty, seed + 4) > 0.93) {
        ctx.fillStyle = 'rgba(20,12,24,0.6)';
        let cx = 3 + ((hash(tx, ty, 9) * 8) | 0);
        for (let y = 2; y < 13; y++) {
          ctx.fillRect(ox + cx, oy + y, 1, 1);
          if (hash(tx, y, 11) > 0.6) cx += hash(ty, y, 12) > 0.5 ? 1 : -1;
        }
      }
      if (at(tx, ty - 1) === T.Wall) {
        ctx.fillStyle = 'rgba(8,4,12,0.45)';
        ctx.fillRect(ox, oy, TILE, 4);
        ctx.fillStyle = 'rgba(8,4,12,0.25)';
        ctx.fillRect(ox, oy + 4, TILE, 3);
      }
      if (t === T.Stairs) {
        const lx = at(tx - 1, ty) === T.Stairs ? 0 : 1;
        const top = at(tx, ty - 1) === T.Stairs ? 0 : 1;
        for (let y = 0; y < TILE; y++) {
          const step = Math.floor((y + (top ? 0 : TILE)) / 5);
          const v = Math.max(0, 70 - step * 11);
          ctx.fillStyle = rgb(v * 0.6, v * 0.5, v * 0.75);
          ctx.fillRect(ox + lx, oy + y + (top ? 1 : 0), TILE - lx, 1);
        }
      }
    }
  tex.refresh();
}
