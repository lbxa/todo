/**
 * The app icon, drawn as the checklist's own tick mark: an accent-filled circle
 * with a white check, on the Lights-out canvas. Colours are the theme tokens
 * from src/theme.css so the icon and the default theme cannot drift apart.
 */
export const CANVAS = '#000000';
export const ACCENT = '#0a84ff';
export const ONACCENT = '#ffffff';

/**
 * @param {number} radiusRatio circle radius as a fraction of the 512 canvas.
 *   Maskable icons need their content inside the middle 80%, so they draw smaller.
 */
export function iconSvg(radiusRatio = 0.293) {
  const S = 512;
  const c = S / 2;
  const r = S * radiusRatio;
  // Check geometry expressed relative to r, so it scales with the circle.
  const p = (dx, dy) => `${(c + dx * r).toFixed(1)},${(c + dy * r).toFixed(1)}`;
  const check = `M ${p(-0.42, 0.02)} L ${p(-0.12, 0.34)} L ${p(0.44, -0.34)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" fill="${CANVAS}"/>
  <circle cx="${c}" cy="${c}" r="${r.toFixed(1)}" fill="${ACCENT}"/>
  <path d="${check}" fill="none" stroke="${ONACCENT}" stroke-width="${(r * 0.24).toFixed(1)}"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}
