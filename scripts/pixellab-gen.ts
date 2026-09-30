// Generates concept sprites with the PixelLab API into art/pixellab/.
// Usage: PIXELLAB_API_TOKEN=... npx tsx scripts/pixellab-gen.ts [name...]
import { mkdirSync, writeFileSync } from 'node:fs';

const STYLE = 'dark fantasy dungeon crawler, top-down roguelike';
const SPRITES: Record<string, { desc: string; size?: number }> = {
  'hero-archer': { desc: 'hooded archer with green tunic and a quiver of arrows' },
  'hero-knight': { desc: 'knight in silver plate armor with a plumed great helm and red tabard' },
  grunt: { desc: 'small green goblin grunt with yellow eyes and horns' },
  'skeleton-archer': { desc: 'skeleton archer with red glowing eyes holding a bow' },
  brute: { desc: 'huge red horned ogre brute', size: 48 },
  'bone-warden': { desc: 'giant skeletal boss, the Bone Warden, wearing a bone crown and tattered robes', size: 64 },
  'explosive-barrel': { desc: 'red explosive powder barrel with iron bands' },
  potion: { desc: 'red health potion bottle', size: 32 },
  'floor-tile': { desc: 'cracked dark stone dungeon floor tile, seamless', size: 32 },
};

const token = process.env.PIXELLAB_API_TOKEN;
if (!token) throw new Error('PIXELLAB_API_TOKEN not set');
const out = new URL('../art/pixellab/', import.meta.url);
mkdirSync(out, { recursive: true });

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SPRITES);
for (const name of names) {
  const { desc, size = 32 } = SPRITES[name];
  const tile = name.endsWith('tile');
  // Free plan runs one job at a time, and a finished job holds the slot for a few seconds.
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await post(desc, size, tile);
    if (res.status !== 429 || attempt === 5) break;
    await new Promise((r) => setTimeout(r, 3000 * 2 ** attempt));
  }
  if (!res.ok) {
    console.error(name, res.status, await res.text());
    continue;
  }
  const { image } = (await res.json()) as { image: { base64: string } };
  writeFileSync(new URL(`${name}.png`, out), Buffer.from(image.base64.replace(/^data:.*?,/, ''), 'base64'));
  console.log('wrote', name);
}

function post(desc: string, size: number, tile: boolean) {
  return fetch('https://api.pixellab.ai/v2/create-image-pixflux', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: `${desc}, ${STYLE}`,
      image_size: { width: size, height: size },
      outline: 'single color black outline',
      shading: 'basic shading',
      detail: 'medium detail',
      view: tile ? 'high top-down' : 'low top-down',
      ...(tile ? {} : { direction: 'south', no_background: true }),
      seed: 7,
    }),
  });
}
