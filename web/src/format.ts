/** Value for <input type="datetime-local">, in the user's local time. */
export function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The next full hour after `now`. */
export function nextFullHour(now: Date): Date {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

export function formatWhen(iso: string | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString("sv-SE", { dateStyle: "medium", timeStyle: "short" });
}

export const CHANNEL_LABELS: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  pinterest: "Pinterest",
  youtube: "YouTube",
  snapchat: "Snapchat",
  x: "X",
};
