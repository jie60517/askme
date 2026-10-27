import { clsx, type ClassValue } from "clsx";

/**
 * 合併 class 名稱。
 *
 * ⚠️ **這個專案刻意只用 `clsx`,沒有 `tailwind-merge`。**
 * twMerge 的價值是「同性質的 Tailwind 工具類疊在一起時後者贏」,而這裡
 * 沒有 Tailwind —— kit 用到的那幾十個類是 `styles/pet-shim.css` 用 Astryx
 * token 手工實作的靜態組合,不會有需要仲裁的重疊。多帶它等於為了一個用不到的
 * 能力多背一個相依,也會讓人誤以為這站有 Tailwind。
 *
 * 搬到有裝 Tailwind 的專案時再換成 `twMerge(clsx(inputs))`。
 */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}
