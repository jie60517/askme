/**
 * 調色盤用的 HSV ↔ `#rrggbb`(Bloub 自訂顏色)。
 *
 * 面板自己記著 HSV,不從 hex 回推:拖到灰階(飽和度 0)或全黑(亮度 0)時,
 * hex 推不回色相,色相條會跳回紅色。
 */

/** `#rrggbb`,一律小寫。Bloub 自訂色、調色盤都只認這一種寫法(後端 `users._pick_color` 同一條) */
export type HexColor = `#${string}`;

export const isHexColor = (v: unknown): v is HexColor => typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v);

export type Hsv = {
  /** 0 ≤ h < 360 */
  h: number;
  /** 0..1 */
  s: number;
  /** 0..1 */
  v: number;
};

export function hsvToHex({h, s, v}: Hsv): HexColor {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `#${[f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** `#rrggbb`(小寫)→ HSV。不是這個格式的回 null */
export function hexToHsv(hex: string): Hsv | null {
  if (!isHexColor(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return {h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max};
}

/**
 * 色碼輸入框打的字 → `#rrggbb`(小寫)。少打 `#`、大寫都收;不完整或不合法的回 null(還在打)。
 */
export function parseHexInput(text: string): HexColor | null {
  const t = text.trim().toLowerCase();
  const withHash = t.startsWith('#') ? t : `#${t}`;
  return isHexColor(withHash) ? withHash : null;
}
