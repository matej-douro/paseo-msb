/**
 * Short, opaque name token. The alphabet stays inside the shared name schema
 * (lowercase letters and digits), so a generated name is always a valid slug.
 * Names are host-local labels, not secrets or capabilities: ownership is proven
 * by the managed/parent labels and the exact handle id, so a non-cryptographic
 * PRNG is adequate for avoiding accidental collisions.
 */
const TOKEN_LENGTH = 10;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * One generated child name per create attempt. The name is the create identity,
 * so the modal reuses it across transient RPC failures and only replaces it
 * after a successful submit.
 */
export function newGeneratedChildName(): string {
  let token = "";
  while (token.length < TOKEN_LENGTH) {
    token += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `paseo-${token}`;
}
