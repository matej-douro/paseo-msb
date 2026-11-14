import {
  GUEST_HOME,
  GUEST_PATH,
  GUEST_USER,
  PI_PACKAGE,
  PI_PREFIX,
  PI_VERSION,
} from "../shared/constants";
import type { ExecSpec } from "./sandbox";

/**
 * Legacy detached Pi installation: non-root install as `paseo`, ignoring
 * lifecycle scripts, into the historical prefix that the guest
 * PATH already exposes.
 */
export function piInstallSpec(): ExecSpec {
  return {
    command: "npm",
    args: [
      "install",
      "-g",
      "--ignore-scripts",
      "--prefix",
      PI_PREFIX,
      `${PI_PACKAGE}@${PI_VERSION}`,
    ],
    user: GUEST_USER,
    env: { HOME: GUEST_HOME, PATH: GUEST_PATH },
    stdinNull: true,
  };
}

/** The exact argv the detached Pi install job must match during recovery. */
export function piInstallArgv(): readonly string[] {
  const spec = piInstallSpec();
  return [spec.command, ...spec.args];
}
