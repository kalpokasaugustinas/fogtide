# makes a soft, seamless fog background for the itch.io page (edit theme -> background)
# output: dist/itch/bg_fog.png (+ .jpg). the noise is built in fourier space, so it wraps
# perfectly on every edge and works both as a single image and as a repeating tile.
import numpy as np
from PIL import Image
from pathlib import Path

w, h = 1920, 1080
rng = np.random.default_rng(7)  # fixed seed = same image every run
out_dir = Path(__file__).resolve().parent.parent / "dist" / "itch"


def fog_noise(stretch_x, beta, seed_shift):
    """periodic fractal noise; stretch_x > 1 makes wisps drift sideways like sea fog"""
    fx = np.fft.fftfreq(w)[None, :] * stretch_x  # higher x freq weight -> longer horizontal features
    fy = np.fft.fftfreq(h)[:, None]
    f = np.sqrt(fx ** 2 + fy ** 2)
    f[0, 0] = 1.0                       # avoid divide by zero at the dc term
    amp = 1.0 / f ** beta               # 1/f^beta -> smooth, cloud-like falloff
    amp[0, 0] = 0.0
    phase = np.exp(2j * np.pi * rng.random((h, w)) + seed_shift)
    n = np.real(np.fft.ifft2(amp * phase))
    return (n - n.min()) / (n.max() - n.min())  # normalise to 0..1


def smooth(x, lo, hi):
    """smoothstep: soft threshold so fog has puffy edges instead of flat noise"""
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


# three layers: big slow banks, mid wisps, fine grain
big = fog_noise(2.2, 1.6, 0)
mid = fog_noise(3.0, 1.3, 1)
fine = fog_noise(1.5, 1.0, 2)

density = 0.55 * big + 0.33 * mid + 0.12 * fine
fog = smooth(density, 0.38, 0.78)         # 0 = clear air, 1 = thick fog
shade = smooth(1 - big, 0.45, 0.9)         # darker hollows under the banks

# colours taken from the game's style.css
deep = np.array([0x86, 0x9f, 0xa2], float)   # shadowed sea-grey
base = np.array([0xa9, 0xbc, 0xbc], float)   # --bg
mist = np.array([0xe8, 0xef, 0xee], float)   # bright fog highlight

col = base[None, None, :] * (1 - shade[..., None] * 0.6) + deep * (shade[..., None] * 0.6)
col = col * (1 - fog[..., None]) + mist * fog[..., None]
col += (rng.random((h, w, 1)) - 0.5) * 3      # tiny dither so gradients don't band
img = Image.fromarray(np.clip(col, 0, 255).astype(np.uint8), "RGB")

out_dir.mkdir(parents=True, exist_ok=True)
img.save(out_dir / "bg_fog.png", optimize=True)
img.save(out_dir / "bg_fog.jpg", quality=90)

# 2x2 tiled preview to check the seams (scratch use only)
prev = Image.new("RGB", (w * 2, h * 2))
for dx in (0, w):
    for dy in (0, h):
        prev.paste(img, (dx, dy))
prev.resize((w, h)).save(out_dir / "_bg_tile_check.jpg", quality=80)
print("saved", out_dir / "bg_fog.png")
