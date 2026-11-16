import { generatedChildName } from "../shared/constants";

/**
 * Short, opaque name token. The alphabet stays inside the shared name schema
 * (lowercase letters and digits), so a generated name is always a valid slug.
 * Names are host-local, not capability tokens, so ~52 bits of entropy is ample.
 */
const TOKEN_LENGTH = 10;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** Largest multiple of the alphabet size that fits in a byte; reject the rest. */
const MAX_SAMPLE = 256 - (256 % ALPHABET.length);

/**
 * One generated child name per create attempt. The name is the create identity,
 * so the modal reuses it across transient RPC failures and only replaces it
 * after a successful submit.
 */
export function newGeneratedChildName(): string {
  return generatedChildName(randomToken(TOKEN_LENGTH));
}

function randomToken(length: number): string {
  const cryptoApi = (
    globalThis as {
      crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array };
    }
  ).crypto;

  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    try {
      return randomFromCrypto(cryptoApi.getRandomValues.bind(cryptoApi), length);
    } catch {
      // A present but unusable crypto API falls through to the fallback.
    }
  }

  let token = "";
  while (token.length < length) {
    token += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return token;
}

function randomFromCrypto(
  getRandomValues: (array: Uint8Array) => Uint8Array,
  length: number,
): string {
  const bytes = new Uint8Array(length * 2);
  let token = "";
  while (token.length < length) {
    getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= MAX_SAMPLE) continue;
      token += ALPHABET[byte % ALPHABET.length];
      if (token.length === length) break;
    }
  }
  return token;
}
