# stamps a build number + timestamp into a static web game and cache-busts its files.
# - index.html: <span id="version">...</span> becomes "build N · yyyy-mm-dd hh:mm"
# - index.html: local css/js links get ?v=N
# - js files: relative imports (static and dynamic) get ?v=N, so phones never mix cached old and new files
# build number = git commits so far + 1 (the commit being made)
# usage: python tools/stamp_version.py [--stage]   (--stage = git add the files it changed; used by the pre-commit hook)
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

root = Path(__file__).resolve().parent.parent
stage = "--stage" in sys.argv

count = subprocess.run(["git", "rev-list", "--count", "HEAD"], cwd=root, capture_output=True, text=True).stdout.strip()
build = int(count or 0) + 1
stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
changed = []


def rewrite(path, fn):
    # apply fn to the file text, write back with lf endings only if it changed
    src = path.read_text(encoding="utf-8")
    new = fn(src)
    if new != src:
        path.write_text(new, encoding="utf-8", newline="\n")
        changed.append(str(path.relative_to(root)))


def stamp_html(html):
    html = re.sub(r'<span id="version">.*?</span>', f'<span id="version">build {build} · {stamp}</span>', html)
    # local (not http/https or //) css and js references
    return re.sub(r'((?:href|src)="(?!https?:|//)[^"?]+\.(?:css|js))(\?v=\d+)?"', rf'\g<1>?v={build}"', html)


def stamp_js(src):
    # import x from './a.js'  /  import('./a.js')  /  export ... from '../b.js'
    return re.sub(r"""((?:from\s+|import\s*\(\s*)(['"])\.{1,2}/[^'"?]+\.js)(\?v=\d+)?\2""", rf"\g<1>?v={build}\g<2>", src)


rewrite(root / "index.html", stamp_html)
skip = {"node_modules", "tools", "dist"}   # dist = build output (copies of the game), never stamped
for js in root.rglob("*.js"):
    if not skip & set(js.relative_to(root).parts):
        rewrite(js, stamp_js)

if stage and changed:
    subprocess.run(["git", "add", *changed], cwd=root, check=True)
print(f"stamped build {build} · {stamp} ({len(changed)} files changed)")
