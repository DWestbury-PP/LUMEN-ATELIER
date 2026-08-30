// A gallery tile: a poster by default, a live shader only while it holds the
// visitor's attention. The poster is a real frame from the studio's own eye,
// so the tile is honest even when it's still; when the tile comes to life the
// shader draws over the poster and the still simply starts to move.
import { useEffect, useRef, useState } from "react";
import ShaderTile from "../gl/ShaderTile";
import { attention, type Attention } from "../gl/attention";
import { api } from "../lib/api";
import type { Piece } from "../lib/types";

// Shader source, fetched once per piece per session.
const shaderCache = new Map<number, Promise<string | null>>();
function loadShader(id: number): Promise<string | null> {
  let p = shaderCache.get(id);
  if (!p) {
    p = api.shader(id).then((r) => r.glsl).catch(() => { shaderCache.delete(id); return null; });
    shaderCache.set(id, p);
  }
  return p;
}

export default function GalleryTile({ piece }: { piece: Piece }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<Attention>("cold");
  const [glsl, setGlsl] = useState<string | null>(piece.glsl ?? null);
  // Once live, a tile stays mounted (holding its last frame) until it leaves
  // the warm zone entirely — then it returns to its poster.
  const [woken, setWoken] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return attention.register(el, setState);
  }, []);

  useEffect(() => {
    if (state === "live") setWoken(true);
    else if (state === "cold") setWoken(false);
  }, [state]);

  useEffect(() => {
    if (!woken || glsl !== null) return;
    let alive = true;
    loadShader(piece.id).then((src) => { if (alive && src) setGlsl(src); });
    return () => { alive = false; };
  }, [woken, glsl, piece.id]);

  const showShader = woken && glsl !== null;

  return (
    <div
      ref={ref}
      className="frame"
      onPointerEnter={() => attention.setHover(ref.current)}
      onPointerLeave={() => attention.setHover(null)}
    >
      {piece.has_poster && (
        <img className="poster" src={api.posterUrl(piece)} alt="" loading="lazy" decoding="async" />
      )}
      {showShader && <ShaderTile glsl={glsl} animate={state === "live"} overlay />}
    </div>
  );
}
