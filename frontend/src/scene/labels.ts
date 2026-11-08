// Text drawn into canvas textures, so labels sit in the 3D world (depth-tested,
// hidden behind racks) instead of floating on top of everything as DOM.

import { useEffect, useState } from 'react';
import * as THREE from 'three';

const FONT_FAMILY = 'Roboto, Inter, system-ui, sans-serif';
const fontsReady: Promise<unknown> =
  typeof document !== 'undefined' && document.fonts
    ? Promise.all([document.fonts.load('500 96px Roboto'), document.fonts.load('500 96px Inter')]).then(() => document.fonts.ready).catch(() => undefined)
    : Promise.resolve();

export function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void fontsReady.then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);
  return ready;
}

/** White text on transparent; tint it with the material colour. */
export function makeTextTexture(text: string, weight = 500, letterSpacing = 0.14): { texture: THREE.CanvasTexture; aspect: number } {
  const px = 96;
  const font = `${weight} ${px}px ${FONT_FAMILY}`;
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d')!;
  g.font = font;
  const chars = [...text];
  const widths = chars.map((ch) => g.measureText(ch).width);
  const spacing = letterSpacing * px;
  const textW = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  const pad = px * 0.3;
  canvas.width = Math.ceil(textW + pad * 2);
  canvas.height = Math.ceil(px * 1.4);
  g.font = font;
  g.fillStyle = '#ffffff';
  g.textBaseline = 'middle';
  let x = pad;
  chars.forEach((ch, i) => {
    g.fillText(ch, x, canvas.height / 2 + px * 0.04);
    x += widths[i] + spacing;
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return { texture, aspect: canvas.width / canvas.height };
}

export function makeLockTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(43,156,252,0.2)';
  g.fillRect(10, 10, 108, 108);
  g.strokeStyle = '#2b9cfc';
  g.lineWidth = 9;
  g.lineCap = 'butt';
  g.beginPath();
  g.arc(64, 54, 16, Math.PI, 0);
  g.lineTo(80, 64);
  g.moveTo(48, 54);
  g.lineTo(48, 64);
  g.stroke();
  g.fillStyle = '#2b9cfc';
  g.fillRect(37, 62, 54, 38);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
