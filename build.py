#!/usr/bin/env python3
"""
Build one offline-capable HTML file.

  1. Tailwind CLI scans src/app.js for class names and emits only the CSS
     those classes need, plus the theme token blocks.
  2. Vendor UMD bundles (React, ReactDOM, Zustand vanilla + middleware, htm)
     are inlined, so the page has no network dependency at all.

No CDN, no build step at runtime. It opens from a file:// URL on a plane.
"""
import pathlib, subprocess, sys

ROOT = pathlib.Path('/home/claude/app')
NM = ROOT / 'node_modules'
OUT = pathlib.Path('/home/claude/move-checklist.html')

VENDOR = [
    NM / 'react/umd/react.production.min.js',
    NM / 'react-dom/umd/react-dom.production.min.js',
    NM / 'zustand/umd/vanilla.production.js',
    NM / 'zustand/umd/middleware.production.js',
    NM / 'htm/dist/htm.umd.js',
]
for p in VENDOR:
    if not p.exists():
        sys.exit(f'missing vendor file: {p}')

# --- 1. compile tailwind ---------------------------------------------------
build_dir = ROOT / 'build'
build_dir.mkdir(exist_ok=True)
css_out = build_dir / 'tw.css'

r = subprocess.run(
    [str(NM / '.bin/tailwindcss'), '-i', 'src/theme.css', '-o', str(css_out), '--minify'],
    cwd=ROOT, capture_output=True, text=True
)
if r.returncode != 0:
    sys.exit('tailwind failed:\n' + r.stderr)
print(r.stderr.strip().splitlines()[-1] if r.stderr.strip() else 'tailwind ok')

css = css_out.read_text()
app = (ROOT / 'src/app.js').read_text()
vendor = '\n'.join(p.read_text() for p in VENDOR)

html = f"""<!DOCTYPE html>
<html lang="en" data-theme="lights-out">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sydney to New York</title>
<style>
{css}
</style>
</head>
<body>
<div id="root"></div>
<script>
{vendor}
</script>
<script>
{app}
</script>
</body>
</html>
"""

OUT.write_text(html)
print(f'built {OUT}  {len(html)/1024:.0f} KB  (css {len(css)/1024:.0f} KB)')
