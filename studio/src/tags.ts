// The tag vocabulary: a controlled palette of words for finding pieces.
// The Muse picks 3-6 at brief time; older pieces are tagged in a backfill.
// Controlled rather than free-form so that browsing by tag actually groups
// things — "serene" means the same thing on every card. Free-text search
// covers everything the vocabulary doesn't.

export const TAG_GROUPS = {
  mood: ["serene", "melancholic", "ecstatic", "ominous", "playful", "meditative", "tense", "tender", "eerie", "triumphant"],
  motion: ["glacial", "drifting", "breathing", "pulsing", "flowing", "turbulent", "spinning", "cascading", "flickering"],
  palette: ["monochrome", "warm", "cool", "neon", "earthen", "pastel", "high-contrast", "gold", "violet", "crimson", "azure", "emerald", "ember", "ivory"],
  form: ["geometric", "organic", "volumetric", "particulate", "lattice", "waves", "field", "bloom", "crystal", "cosmic", "botanical", "architectural", "fluid", "textile", "luminous", "shadowed", "figurative"],
  technique: ["raymarched", "fractal", "noise", "flow-field", "cellular", "kaleidoscopic", "layered", "minimal", "grown"],
} as const;

export const TAG_VOCABULARY: string[] = Object.values(TAG_GROUPS).flat();
const VOCAB = new Set(TAG_VOCABULARY);

export const MAX_TAGS = 6;

/** Keep only vocabulary terms, deduped, at most MAX_TAGS. */
export function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    const s = String(t).trim().toLowerCase();
    if (VOCAB.has(s) && !out.includes(s)) out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
