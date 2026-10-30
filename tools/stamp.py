#!/usr/bin/env python3
"""Vor jeder Veröffentlichung: Dateiliste und Versionskennung in sw.js eintragen (ändert sich nur, wenn sich Dateien ändern)."""
import hashlib, json, os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
skip_dirs = {'.git', 'tools', 'test', '.github', 'node_modules'}
assets, h = ['./', './index.html'], hashlib.sha256()
for d, dirs, files in os.walk(root):
    dirs[:] = sorted(x for x in dirs if x not in skip_dirs)
    for f in sorted(files):
        rel = os.path.relpath(os.path.join(d, f), root).replace(os.sep, '/')
        if rel in ('sw.js', 'index.html', 'README.md', '.nojekyll') or rel.endswith('.md'):
            if rel == 'index.html':
                h.update(open(os.path.join(root, rel), 'rb').read())
            continue
        if rel.startswith('ocr/'): continue   # Texterkennung (groß): erst beim ersten Scan laden, dann zwischenspeichern
        assets.append('./' + rel)
        h.update(rel.encode()); h.update(open(os.path.join(root, rel), 'rb').read())
tpl = open(os.path.join(root, 'tools', 'sw.template.js'), encoding='utf-8').read()
build = h.hexdigest()[:12]
out = tpl.replace("'__BUILD__'", json.dumps(build)).replace('__ASSETS__', json.dumps(assets, indent=2))
open(os.path.join(root, 'sw.js'), 'w', encoding='utf-8').write(out)
print('build', build, len(assets), 'Dateien')
