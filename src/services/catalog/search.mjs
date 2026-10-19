// Ported from the client's src/utils/search.js so the shop and the API match a search the same way.
// Change both together.
// Lower case, no accents, punctuation as spaces: "Cross-Back Sports Bra" and "cross back sports bra" read the same.
const plain = (text) =>
  String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// A plural worn down to its singular, so "leggings" finds "legging" and "bras" finds "bra".
const singular = (word) => {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("es") && /(ch|sh|x|ss|z)es$/.test(word)) return word.slice(0, -2);
  return word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
};

// Edit distance that counts a swap of two neighbouring letters as one slip ("lgeging"), stopping early once it passes `max`.
function slips(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      row[j] = d;
      best = Math.min(best, d);
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

// How many slips a typed word may have: none when short (so "bra" stays "bra"), one up to five letters, two beyond.
const allowed = (w) => (w.length <= 3 ? 0 : w.length <= 5 ? 1 : 2);

/**
 * Whether some text matches what a person typed, close enough rather than
 * exact. Every word typed has to find a word in the text, in any order, by
 * any of: starting it ("legg" finds "Leggings"), being its plural or singular,
 * being a slip or two away from it ("legings", "swimm", "sprots bra"), or
 * running two words together ("highwaist" finds "High-Waist"). Capitals,
 * accents and punctuation are ignored. A word of three letters or fewer has
 * to be a whole word, so "bra" finds bras but not "brand". An empty search
 * matches everything. One matcher for every search box on the shop and in
 * the dashboard.
 */
export function matchesSearch(text, query) {
  const words = plain(query).split(" ").filter(Boolean);
  if (!words.length) return true;
  const hay = plain(text).split(" ");
  const joined = hay.join("");
  return words.every((w) => {
    const one = singular(w);
    if (w.length <= 3) return hay.some((h) => h === w || h === `${w}s` || h === `${w}es`);
    if (hay.some((h) => h.startsWith(w) || h.startsWith(one))) return true;
    if (w.length >= 6 && joined.includes(w)) return true;
    // A near miss: the typed word against the same number of letters from the start of each word (so a half-typed, misspelt word still lands).
    const max = allowed(w);
    return hay.some((h) => h.length >= 3 && [w.length - 1, w.length, w.length + 1].some((n) => n >= 3 && slips(w, h.slice(0, n), max) <= max));
  });
}
