/** クリック起点のオーバーレイ(ポップオーバー/リンクメニュー)の配置計算を共有する。 */

export interface VisibleBounds {
  /** クリック時点の可視範囲(コンテンツ座標)の左上・右下端 */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** lo..hi にクランプする。hi<lo の縮退時は lo を優先する(可視範囲がサイズより狭い場合の保険)。 */
export const clampOverlay = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * (x,y) の近傍にサイズ (w,h) のオーバーレイを配置する。右端/下端に収まらない側では
 * 反転配置し、可視範囲(min..max)の両端にクランプしてはみ出しを防ぐ。
 */
export function placeOverlay(x: number, y: number, w: number, h: number, b: VisibleBounds): { left: number; top: number } {
  const left = x + w + 16 > b.maxX ? clampOverlay(x - w - 8, b.minX, b.maxX - w) : x + 8;
  const top = y + h + 16 > b.maxY ? clampOverlay(y - h - 8, b.minY, b.maxY - h) : y + 8;
  return { left, top };
}
