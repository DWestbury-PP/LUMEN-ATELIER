// Optional research wing: when a Tavily key is present, the Muse can ground a
// brief in real art-history sources instead of working purely from memory.

import { config } from "./config.js";

const MOVEMENTS = [
  "Art Nouveau ironwork and glass",
  "Mark Rothko color field painting",
  "Japanese ukiyo-e wave prints",
  "Bridget Riley op art",
  "Art Deco architecture ornament",
  "James Turrell light installations",
  "Sol LeWitt wall drawings",
  "Aurora borealis photography",
  "Bauhaus geometric composition",
  "demoscene 4k intro aesthetics",
  "Islamic geometric tile patterns",
  "Yayoi Kusama infinity rooms",
  "bioluminescent deep sea life",
  "Zaha Hadid parametric architecture",
  "stained glass cathedral windows",
  "brutalist concrete architecture",
  "Hokusai and Hiroshige landscapes",
  "Dan Flavin fluorescent light art",
  "microscopy photography of crystals",
  "Olafur Eliasson atmosphere installations",
];

export interface Research {
  subject: string;
  notes: string[];
}

export async function maybeResearch(theme: string | null): Promise<Research | null> {
  if (!config.tavilyApiKey) return null;
  const subject = theme
    ? `${theme} — visual art references`
    : MOVEMENTS[Math.floor(Math.random() * MOVEMENTS.length)];
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: config.tavilyApiKey,
        query: `${subject} visual characteristics color palette composition`,
        max_results: 4,
        search_depth: "basic",
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: { title: string; content: string }[] };
    const notes = (data.results ?? [])
      .slice(0, 4)
      .map((r) => `${r.title}: ${r.content}`.slice(0, 500));
    return notes.length ? { subject, notes } : null;
  } catch {
    return null;
  }
}
