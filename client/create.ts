import type { CredentialName } from "./types";

export interface CreateAttempt {
  readonly requestId: string;
}

function uuidFromBytes(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (const byte of bytes) hex.push(byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

export function createRequestId(): string {
  const runtimeCrypto = globalThis.crypto as
    | {
        randomUUID?: () => string;
        getRandomValues?: (values: Uint8Array) => Uint8Array;
      }
    | undefined;

  if (runtimeCrypto?.randomUUID) return runtimeCrypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (runtimeCrypto?.getRandomValues) {
    runtimeCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return uuidFromBytes(bytes);
}

export function newCreateAttempt(
  generate: () => string = createRequestId,
): CreateAttempt {
  return { requestId: generate() };
}

export function toggleCredential(
  selected: readonly CredentialName[],
  name: CredentialName,
  available: readonly CredentialName[],
): CredentialName[] {
  if (!available.includes(name)) return [...selected];
  if (selected.includes(name)) return selected.filter((entry) => entry !== name);
  return [...selected, name];
}

export function canCreate(
  selected: readonly CredentialName[],
  available: readonly CredentialName[],
): boolean {
  return (
    selected.length > 0 && selected.every((name) => available.includes(name))
  );
}
