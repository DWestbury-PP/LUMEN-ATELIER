export interface Brief {
  title_working: string;
  concept: string;
  palette: string[];
  reference: string;
  motion: string;
  composition: string;
  mood: string;
}

export interface Critique {
  verdict: "approve" | "revise" | "decline";
  scores: { composition: number; color: number; motion: number; fidelity: number; overall: number };
  critique: string;
  suggestions: string[];
}

export interface Ledger {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  by_model: Record<string, { calls: number; input: number; output: number; cost_usd: number }>;
}

export interface Piece {
  id: number;
  ledger?: Ledger | null;
  inspiration?: string[] | null;
  title: string | null;
  statement: string | null;
  theme: string | null;
  patron: string | null;
  brief: Brief | null;
  glsl: string | null;
  status: string;
  seed: boolean;
  iterations: number;
  created_at: string;
  approved_at: string | null;
}

export interface IterationRow {
  idx: number;
  glsl: string;
  artisan_notes: string | null;
  compile_ok: boolean | null;
  compile_log: string | null;
  frames: string[] | null;
  critique: Critique | null;
  created_at: string;
}

export interface PieceDetail extends Piece {
  iterationRows: IterationRow[];
}

export interface StudioStatus {
  hasKey: boolean;
  phase: string;
  currentPieceId: number | null;
  queueLength: number;
  models: { muse: string; artisan: string; critic: string };
  maxIterations: number;
}

export interface StudioEvent {
  type: string;
  pieceId: number | null;
  payload: Record<string, unknown>;
  at: string;
}
