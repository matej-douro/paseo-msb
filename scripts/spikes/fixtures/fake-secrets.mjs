// Fake values only. Never read or forward real credentials in this spike.

import { CREDENTIALS, CONTROLLED_SECRET_ENV } from "./pins.mjs";

const FAKE_PREFIX = "FAKE-PASEO-MSB-SPIKE";
const RUN_SALT = "vertical-slice-v1";

function fakeValue(name) {
  return `${FAKE_PREFIX}-${name}-${RUN_SALT}-not-a-real-credential`;
}

export const FAKE_SECRETS = Object.freeze(
  Object.fromEntries([
    ...CREDENTIALS.map(({ env }) => [env, fakeValue(env)]),
    [CONTROLLED_SECRET_ENV, fakeValue(CONTROLLED_SECRET_ENV)],
  ]),
);

export const FAKE_SECRET_MARKERS = Object.freeze(Object.values(FAKE_SECRETS));

export function assertNoFakeSecrets(text, where) {
  for (const marker of FAKE_SECRET_MARKERS) {
    if (text.includes(marker)) {
      throw new Error(`fake secret value leaked into ${where}`);
    }
  }
}
