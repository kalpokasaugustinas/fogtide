# windows desktop build (for steam and testers): wraps the committed game files in electron.
# no node/npm needed: downloads electron's prebuilt windows zip once (checksum-verified, cached in
# dist/cache/), copies the game into resources/app, renames the exe and sets its icon.
#
# usage:
#   python tools/build_desktop.py            -> dist/desktop/Fogtide/Fogtide.exe
#                                               + dist/fogtide-windows-build<N>.zip (send to testers)
#   python tools/build_desktop.py --no-zip   -> folder only (faster, for local runs)
# debug against the working tree without rebuilding:
#   dist/desktop/Fogtide/Fogtide.exe --game-dir=<repo folder> --dev --windowed
import hashlib
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

electron_version = "44.9.3"   # pinned stable release; bump deliberately, then rebuild + test
rcedit_version = "2.0.0"      # electron's own tool for exe icon / version info

root = Path(__file__).resolve().parent.parent
dist = root / "dist"
cache = dist / "cache"
out_dir = dist / "desktop" / "Fogtide"
app_dir = out_dir / "resources" / "app"

# game files: only committed files (same rule as the itch zip), minus dev tools and web-only files
skip_dirs = ("tools/", "desktop/")
skip_files = {".gitignore", "README.md", "sw.js", "manifest.webmanifest"}


def download(url, dest):
    # fetch a url into dest once; later builds reuse the cached file
    if dest.exists():
        return dest
    print(f"downloading {url}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    tmp.rename(dest)
    return dest


def electron_zip():
    # electron zip, checked against the release's published sha256 list
    name = f"electron-v{electron_version}-win32-x64.zip"
    base = f"https://github.com/electron/electron/releases/download/v{electron_version}/"
    z = download(base + name, cache / name)
    sums = download(base + "SHASUMS256.txt", cache / f"SHASUMS256-{electron_version}.txt").read_text()
    want = next(line.split()[0] for line in sums.splitlines() if line.endswith(name))
    got = hashlib.sha256(z.read_bytes()).hexdigest()
    if got != want:
        z.unlink()
        sys.exit(f"checksum mismatch for {name}; deleted, run again")
    return z


def make_ico():
    # windows icon (several sizes in one .ico) from the 512 px game icon
    from PIL import Image
    ico = cache / "fogtide.ico"
    Image.open(root / "img" / "icon-512.png").save(ico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    return ico


def main():
    build = re.search(r"build (\d+)", (root / "index.html").read_text(encoding="utf-8")).group(1)
    files = subprocess.run(["git", "ls-files"], cwd=root, capture_output=True, text=True, check=True).stdout.split()
    files = [f for f in files if not f.startswith(skip_dirs) and f not in skip_files]

    # fresh electron runtime
    if out_dir.exists():
        shutil.rmtree(out_dir)
    with zipfile.ZipFile(electron_zip()) as z:
        z.extractall(out_dir)
    (out_dir / "resources" / "default_app.asar").unlink(missing_ok=True)   # electron's demo app
    # chromium ui translations (~40 MB): the game is english-only, so keep just en-US
    for pak in (out_dir / "locales").glob("*.pak"):
        if pak.name != "en-US.pak":
            pak.unlink()
    exe = out_dir / "Fogtide.exe"
    (out_dir / "electron.exe").rename(exe)

    # game files + the electron entry point (desktop/main.js, desktop/package.json)
    for f in files:
        dest = app_dir / f
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / f, dest)
    for f in ("main.js", "package.json"):
        shutil.copy2(root / "desktop" / f, app_dir / f)

    # exe icon + file details (shown in explorer and task manager)
    rcedit = download(f"https://github.com/electron/rcedit/releases/download/v{rcedit_version}/rcedit-x64.exe", cache / f"rcedit-{rcedit_version}.exe")
    subprocess.run([str(rcedit), str(exe), "--set-icon", str(make_ico()),
                    "--set-version-string", "ProductName", "Fogtide",
                    "--set-version-string", "FileDescription", "Fogtide",
                    "--set-version-string", "OriginalFilename", "Fogtide.exe",
                    "--set-file-version", f"1.0.{build}", "--set-product-version", f"1.0.{build}"], check=True)
    print(f"{exe}  (build {build}, {len(files)} game files)")

    # zip for testers: unzip anywhere, run Fogtide.exe
    if "--no-zip" not in sys.argv:
        zpath = dist / f"fogtide-windows-build{build}.zip"
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
            for p in out_dir.rglob("*"):
                if p.is_file():
                    z.write(p, Path("Fogtide") / p.relative_to(out_dir))
        print(f"{zpath}  ({zpath.stat().st_size / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
