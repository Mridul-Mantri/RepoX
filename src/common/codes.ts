// Crypto-safe code generation. Pickup pass codes are printed on QR — must be
// unambiguous and unguessable. We use a 32-char alphabet without 0/O/I/1.

import { randomBytes } from 'crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomBlock(len = 4): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** "RPX-2847-KFGX" — order number + pickup pass. */
export function generatePickupPass(): string {
  return `RPX-${randomBlock(4)}-${randomBlock(4)}`;
}

/** "LOT-MH-NOV-22" — Lot identifier. */
export function generateLotNumber(stateCode = 'IN'): string {
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const m = months[new Date().getMonth()];
  const seq = randomBlock(2);
  return `LOT-${stateCode.toUpperCase().slice(0, 3)}-${m}-${seq}`;
}

/** 6-digit numeric OTP for pickup verification. */
export function generateOtp(): string {
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, '0');
}

/** Invoice number "INV-2026-000001" — pass a sequence from DB. */
export function generateInvoiceNumber(sequence: number): string {
  return `INV-${new Date().getFullYear()}-${sequence.toString().padStart(6, '0')}`;
}
