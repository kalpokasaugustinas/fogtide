// fog ui (pc theme): the cloud-noise texture that frays the edges of the fog panels into wisps.
// made once at start as a small tileable png and handed to css as --fog-noise (pc.css .fog::after
// uses it as a mask and slides it slowly, so the wisps drift without any per-frame js).

// n = tile size in px. three octaves of random grids, each repeated 3x3 at its small size before
// the upscale (so the smoothing blends across the tile edges and the texture repeats without
// seams), blurred into round puffs, then a brightness -> alpha curve leaves wispy holes
export function initFogNoise(n = 220) {
  const out = document.createElement('canvas');
  out.width = out.height = n;
  const o = out.getContext('2d');
  for (const [g, w] of [[6, 0.55], [12, 0.3], [24, 0.15]]) {
    const s = document.createElement('canvas');
    s.width = s.height = g * 3;
    const sx = s.getContext('2d'), img = sx.createImageData(g * 3, g * 3), cell = [];
    for (let i = 0; i < g * g; i++) cell.push(Math.random() * 255);
    for (let y = 0; y < g * 3; y++) for (let x = 0; x < g * 3; x++) {
      const v = cell[(y % g) * g + (x % g)];
      img.data.set([v, v, v, 255], (y * g * 3 + x) * 4);
    }
    sx.putImageData(img, 0, 0);
    const t = document.createElement('canvas');
    t.width = t.height = n * 3;
    const tx = t.getContext('2d');
    tx.imageSmoothingEnabled = true;
    tx.imageSmoothingQuality = 'high';
    tx.filter = `blur(${(n / g) * 0.35}px)`;   // bilinear diamonds -> round puffs
    tx.drawImage(s, 0, 0, n * 3, n * 3);
    o.globalAlpha = w;
    o.drawImage(t, n, n, n, n, 0, 0, n, n);   // the middle tile of the 3x3
  }
  // brightness -> alpha: below ~0.38 clear, above ~0.62 solid, smoothstep between
  const d = o.getImageData(0, 0, n, n);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = d.data[i] / 255, a = Math.min(1, Math.max(0, (v - 0.38) / 0.24));
    d.data[i] = d.data[i + 1] = d.data[i + 2] = 0;
    d.data[i + 3] = a * a * (3 - 2 * a) * 255;
  }
  o.putImageData(d, 0, 0);
  document.documentElement.style.setProperty('--fog-noise', `url(${out.toDataURL()})`);
}
