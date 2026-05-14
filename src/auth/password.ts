// ============================================================
// RHODES — Password hashing via bcryptjs
// Centralized so the cost factor is one knob.
// ============================================================

import bcrypt from "bcryptjs";

export const BCRYPT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new Error("[auth/password] password must be a non-empty string");
  }
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (typeof plain !== "string" || typeof hash !== "string") return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
