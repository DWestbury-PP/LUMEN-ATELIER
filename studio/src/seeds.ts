// Calibration pieces — hand-written by the studio's architect before the
// ensemble came online, used to verify the renderer, the gallery, and the
// exhibition pipeline. Marked seed=true and credited as such in the UI.

import { q } from "./db.js";

const AURORA = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
out vec4 fragColor;

mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453123); }
float noise(vec2 p){
  vec2 i=floor(p), f=fract(p);
  vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),
             mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);
}
float fbm(vec2 p){
  float v=0.0, a=0.5;
  for(int i=0;i<5;i++){ v+=a*noise(p); p=rot(0.5)*p*2.02; a*=0.55; }
  return v;
}
void main(){
  vec2 uv=(gl_FragCoord.xy*2.0-iResolution.xy)/iResolution.y;
  float t=iTime*0.12;
  vec2 q2=vec2(fbm(uv+vec2(0.0,t)), fbm(uv+vec2(5.2,1.3)-t*0.7));
  vec2 r2=vec2(fbm(uv+4.0*q2+vec2(1.7,9.2)+t*0.4), fbm(uv+4.0*q2+vec2(8.3,2.8)-t*0.3));
  float f=fbm(uv+4.0*r2);
  float curtain=smoothstep(-1.2, 0.9, uv.y + f*1.6 - q2.y);
  vec3 deep=vec3(0.016,0.031,0.078);
  vec3 teal=vec3(0.043,0.38,0.42);
  vec3 green=vec3(0.24,0.85,0.56);
  vec3 violet=vec3(0.42,0.24,0.62);
  vec3 col=deep;
  col=mix(col, violet, smoothstep(0.2,0.9,q2.x)*0.5);
  col=mix(col, teal, smoothstep(0.25,0.85,f));
  col=mix(col, green, pow(smoothstep(0.45,0.95,f*curtain),2.0));
  vec2 sp=gl_FragCoord.xy/iResolution.y*90.0;
  float star=step(0.9975,hash(floor(sp)))*pow(0.5+0.5*sin(iTime*0.8+hash(floor(sp))*44.0),3.0);
  col+=star*vec3(0.8,0.9,1.0)*(1.0-curtain*0.6);
  float vig=1.0-0.45*dot(uv*0.68,uv*0.68);
  col*=vig;
  col+=(hash(gl_FragCoord.xy+fract(iTime))*2.0-1.0)*0.012;
  fragColor=vec4(pow(max(col,vec3(0.0)),vec3(0.9)),1.0);
}`;

const GYROID = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
out vec4 fragColor;

mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }
float gyroid(vec3 p, float s){
  p*=s;
  return abs(dot(sin(p), cos(p.zxy)))/s - 0.04;
}
float map(vec3 p){
  p.xz*=rot(iTime*0.1);
  p.yz*=rot(0.3+sin(iTime*0.07)*0.3);
  float bound=length(p)-2.1;
  float g=gyroid(p+vec3(0.0,iTime*0.05,0.0), 2.0+0.4*sin(iTime*0.11));
  return max(g, bound);
}
void main(){
  vec2 uv=(gl_FragCoord.xy*2.0-iResolution.xy)/iResolution.y;
  vec3 ro=vec3(0.0,0.0,-3.6);
  vec3 rd=normalize(vec3(uv,1.7));
  float t=0.0, glow=0.0;
  for(int i=0;i<90;i++){
    vec3 p=ro+rd*t;
    float d=map(p);
    glow+=exp(-abs(d)*9.0)*0.02;
    t+=max(abs(d)*0.8,0.01);
    if(t>8.0) break;
  }
  vec3 gold=vec3(1.0,0.72,0.31);
  vec3 ember=vec3(0.85,0.32,0.12);
  vec3 col=vec3(0.02,0.015,0.02) + gold*glow*glow*1.6 + ember*glow*0.55;
  col*=0.85+0.15*sin(iTime*0.6);
  float vig=1.0-0.5*dot(uv*0.6,uv*0.6);
  col*=vig;
  col+=(fract(sin(dot(gl_FragCoord.xy+fract(iTime),vec2(12.9898,78.233)))*43758.5453)-0.5)*0.02;
  fragColor=vec4(pow(max(col,vec3(0.0)),vec3(0.85)),1.0);
}`;

const MERIDIAN = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
out vec4 fragColor;

float hash(vec2 p){ return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453); }
void main(){
  vec2 uv=(gl_FragCoord.xy*2.0-iResolution.xy)/iResolution.y;
  float r=length(uv), a=atan(uv.y,uv.x);
  float t=iTime*0.3;
  vec3 col=vec3(0.043,0.02,0.078);
  for(int i=0;i<24;i++){
    float fi=float(i);
    float rad=0.08+fi*0.075+0.03*sin(t*1.7+fi*0.6);
    float w=0.004+0.004*sin(fi*2.3+t);
    float ring=smoothstep(w*2.0,0.0,abs(r-rad));
    float dir=mod(fi,2.0)<1.0?1.0:-1.0;
    float phase=a*dir*(6.0+mod(fi,5.0))+t*(0.4+fi*0.05)*dir;
    float dash=0.5+0.5*sin(phase);
    vec3 tint=mix(vec3(0.85,0.25,0.55),vec3(0.35,0.55,1.0),fract(fi*0.19+0.3*sin(t*0.2)));
    col+=ring*dash*tint*(0.55-fi*0.012);
  }
  col+=vec3(1.0,0.9,0.95)*exp(-r*7.0)*(0.7+0.3*sin(t*2.0));
  col*=max(1.0-0.4*r*r,0.0);
  col+=(hash(gl_FragCoord.xy+fract(iTime))-0.5)*0.015;
  fragColor=vec4(pow(max(col,vec3(0.0)),vec3(0.9)),1.0);
}`;

const SEEDS = [
  {
    title: "Calibration I — Aurora Veil",
    statement:
      "A hand-written calibration piece from before the ensemble came online: domain-warped noise drawn as curtains of cold light over a sparse starfield. It exists to prove the studio's eyes and hands work — the ensemble's own work follows.",
    glsl: AURORA,
    brief: {
      title_working: "Aurora Veil",
      concept: "Curtains of auroral light breathing over a northern night.",
      palette: ["#040814", "#0b6169", "#3dd98f", "#6b3d9e"],
      reference: "Aurora borealis long-exposure photography",
      motion: "Slow vertical shimmer; curtains drift and fold over ~20s",
      composition: "Luminous band across the upper two-thirds; sparse stars beneath",
      mood: "Hushed, cold, reverent",
    },
  },
  {
    title: "Calibration II — Reliquary",
    statement:
      "The second calibration piece: a gyroid lattice raymarched as if lit from within, turning slowly like an object of devotion under museum glass. Written by hand to verify the raymarching path of the studio's renderer.",
    glsl: GYROID,
    brief: {
      title_working: "Reliquary",
      concept: "A gold lattice relic rotating in darkness, lit from inside.",
      palette: ["#050405", "#ffb84f", "#d9521f"],
      reference: "Gothic reliquaries; Art Nouveau ironwork",
      motion: "Continuous slow rotation; internal breathing glow",
      composition: "Single centered volume, deep black field",
      mood: "Sacred, warm, patient",
    },
  },
  {
    title: "Calibration III — Meridian Bloom",
    statement:
      "The third calibration piece: two dozen counter-rotating dashed rings blooming from a bright core, an homage to op art's love of rhythm. It verifies the gallery's live-rendering pipeline end to end.",
    glsl: MERIDIAN,
    brief: {
      title_working: "Meridian Bloom",
      concept: "Concentric rhythms orbiting a radiant core.",
      palette: ["#0b0514", "#d9408c", "#598cff", "#fff2f8"],
      reference: "Bridget Riley op art; astronomical orreries",
      motion: "Alternating ring rotation; radii breathe softly",
      composition: "Radially symmetric mandala, centered",
      mood: "Hypnotic, precise, playful",
    },
  },
];

export async function seedIfEmpty(): Promise<boolean> {
  const count = await q.pieceCount();
  if (count > 0) return false;
  for (const s of SEEDS) await q.insertSeed(s);
  return true;
}
