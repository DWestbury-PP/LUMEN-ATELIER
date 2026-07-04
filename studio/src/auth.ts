// Sign in with Google → server-side ID-token verification → signed session
// cookie. Roles gate the commission book:
//   visitor      — can browse everything
//   requested    — asked for commissioning privilege, awaiting approval
//   commissioner — may commission pieces
//   admin        — approves patrons (emails listed in ADMIN_EMAILS)

import crypto from "node:crypto";
import type { Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { config } from "./config.js";
import { q, type UserRow } from "./db.js";

const COOKIE = "lumen_session";
const SESSION_DAYS = 30;

const oauth = config.googleClientId ? new OAuth2Client(config.googleClientId) : null;

// Session secret: required for stable sessions; fall back to an ephemeral one
// (sessions die on restart) so a missing env var degrades instead of crashing.
const secret = config.sessionSecret || crypto.randomBytes(32).toString("hex");
if (!config.sessionSecret) {
  console.warn("[auth] SESSION_SECRET not set — sessions will not survive restarts");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payload: object): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const mac = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

function verify(token: string): { sub: string; exp: number } | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, googleSub: string): void {
  const token = sign({ sub: googleSub, exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies,
    maxAge: SESSION_DAYS * 86400 * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE);
}

export async function userFromRequest(req: Request): Promise<UserRow | null> {
  const token = (req.cookies?.[COOKIE] as string | undefined) ?? "";
  if (!token) return null;
  const payload = verify(token);
  if (!payload) return null;
  return q.userBySub(payload.sub);
}

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export async function verifyGoogleCredential(credential: string): Promise<GoogleProfile> {
  if (!oauth) throw new Error("Google sign-in is not configured (GOOGLE_CLIENT_ID missing)");
  const ticket = await oauth.verifyIdToken({ idToken: credential, audience: config.googleClientId });
  const p = ticket.getPayload();
  if (!p?.sub || !p.email || p.email_verified !== true) {
    throw new Error("Google account could not be verified");
  }
  return { sub: p.sub, email: p.email.toLowerCase(), name: p.name ?? null, picture: p.picture ?? null };
}

export function isAdminEmail(email: string): boolean {
  return config.adminEmails.includes(email.toLowerCase());
}

export function publicUser(u: UserRow) {
  return { id: u.id, email: u.email, name: u.name, picture: u.picture, role: u.role };
}
