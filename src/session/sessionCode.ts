import { randomBytes } from "node:crypto";

const CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateSessionCode(): string {
  const bytes = randomBytes(6);
  const chars = Array.from(bytes, (b) => CHARSET[b % CHARSET.length]);
  return `${chars.slice(0, 3).join("")}-${chars.slice(3).join("")}`;
}

export function validateSessionCode(code: string): boolean {
  // Must be exactly 7 chars: 3 chars from CHARSET, dash, 3 chars from CHARSET
  if (code.length !== 7 || code[3] !== "-") return false;
  const chars = code.slice(0, 3) + code.slice(4);
  return [...chars].every((c) => CHARSET.includes(c));
}
