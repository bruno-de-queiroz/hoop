import { randomBytes } from "node:crypto";

const CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateSessionCode(): string {
  const bytes = randomBytes(6);
  const chars = Array.from(bytes, (b) => CHARSET[b % CHARSET.length]);
  return `${chars.slice(0, 3).join("")}-${chars.slice(3).join("")}`;
}
