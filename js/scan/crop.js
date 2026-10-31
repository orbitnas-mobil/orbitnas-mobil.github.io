// Zuschneiden: vier Ecken per Finger auf das Dokument ziehen (mit Lupe), dann wird das Foto entzerrt.

import { h } from '../util.js';
import { findDocument, quadOk } from './vision.js';

/** Zeigt das Foto im Vollbild mit vier Griffen. Liefert { quad } (Foto-Pixel), { quad: null } für „ganzes Foto“ oder null bei Abbruch. */
export function cropEditor(photo, quad0, { title = 'Zuschneiden' } = {}) {
  return new Promise((resolve) => {
    const W = photo.width, H = photo.height;
    let quad = quad0.map((p) => [...p]);
    const canvas = h('canvas.crop-cv');
    const loupe = h('canvas.crop-loupe', { width: 110, height: 110, hidden: true });
    const hint = h('p.crop-hint', 'Ziehe die vier Punkte auf die Ecken des Dokuments.');
    const done = (v) => { ov.remove(); window.removeEventListener('resize', fit); resolve(v); };
    const ov = h('div.crop-ov',
      h('div.crop-bar', h('b', title), h('button.btn.small', { onclick: () => done(null) }, 'Abbrechen')),
      h('div.crop-stage', canvas, loupe),
      hint,
      h('div.crop-actions',
        h('button.btn', { onclick: () => { const q = findDocument(photo); if (q) { quad = q; draw(); hint.textContent = 'Ränder erkannt – bei Bedarf nachziehen.'; } else hint.textContent = 'Es wurden keine sicheren Ränder erkannt.'; } }, 'Automatisch'),
        h('button.btn', { onclick: () => done({ quad: null }) }, 'Ganzes Foto'),
        h('button.btn.primary', { onclick: () => {
          if (!quadOk(quad, W, H)) { hint.textContent = 'Die Ecken ergeben kein Viereck – bitte so ziehen, dass es nicht überkreuzt ist.'; return; }
          done({ quad });
        } }, 'Übernehmen')));
    document.body.append(ov);

    let scale = 1, drag = -1;
    function fit() {
      const stage = canvas.parentElement;
      const maxW = stage.clientWidth || window.innerWidth, maxH = Math.max(200, (stage.clientHeight || window.innerHeight * 0.6));
      scale = Math.min(maxW / W, maxH / H);
      canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
      draw();
    }
    function draw() {
      const c = canvas.getContext('2d');
      c.drawImage(photo, 0, 0, canvas.width, canvas.height);
      const pts = quad.map(([x, y]) => [x * scale, y * scale]);
      c.save();
      c.fillStyle = 'rgba(0,0,0,.45)';
      c.beginPath(); c.rect(0, 0, canvas.width, canvas.height);
      c.moveTo(pts[0][0], pts[0][1]); for (let i = 3; i >= 0; i--) c.lineTo(pts[i][0], pts[i][1]);
      c.closePath(); c.fill('evenodd');
      c.strokeStyle = '#00D4FF'; c.lineWidth = 2;
      c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.stroke();
      pts.forEach(([x, y], i) => {
        c.beginPath(); c.arc(x, y, i === drag ? 17 : 13, 0, Math.PI * 2);
        c.fillStyle = i === drag ? '#00D4FF' : 'rgba(255,255,255,.9)'; c.fill(); c.strokeStyle = '#00D4FF'; c.lineWidth = 3; c.stroke();
      });
      c.restore();
    }
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]; };
    function showLoupe(i) {
      const [x, y] = quad[i], lc = loupe.getContext('2d'), z = 3, s = loupe.width / z;
      loupe.hidden = false;
      lc.fillStyle = '#000'; lc.fillRect(0, 0, loupe.width, loupe.height);
      lc.drawImage(photo, x - s / 2, y - s / 2, s, s, 0, 0, loupe.width, loupe.height);
      lc.strokeStyle = '#00D4FF'; lc.lineWidth = 1.5;
      lc.beginPath(); lc.moveTo(loupe.width / 2, 0); lc.lineTo(loupe.width / 2, loupe.height); lc.moveTo(0, loupe.height / 2); lc.lineTo(loupe.width, loupe.height / 2); lc.stroke();
      loupe.style.left = x * scale < canvas.width / 2 ? 'auto' : '8px'; loupe.style.right = x * scale < canvas.width / 2 ? '8px' : 'auto';
    }
    canvas.addEventListener('pointerdown', (e) => {
      const [x, y] = pos(e);
      let best = -1, bd = 44 / scale;                 // Griff-Reichweite etwa 44 Bildschirmpunkte
      quad.forEach((q, i) => { const d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) { bd = d; best = i; } });
      if (best < 0) return;
      drag = best; canvas.setPointerCapture(e.pointerId); showLoupe(drag); draw(); e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (drag < 0) return;
      const [x, y] = pos(e);
      quad[drag] = [Math.min(W, Math.max(0, x)), Math.min(H, Math.max(0, y))];
      showLoupe(drag); draw(); e.preventDefault();
    });
    const end = () => { drag = -1; loupe.hidden = true; draw(); };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    window.addEventListener('resize', fit);
    requestAnimationFrame(fit);
  });
}
