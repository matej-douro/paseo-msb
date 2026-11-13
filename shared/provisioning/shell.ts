/**
 * Shell quoting for snippets that are embedded in a POSIX `sh` script.
 *
 * The provisioner passes probes and actions to `sh -c`, so every snippet is
 * first wrapped as a single shell argument. Single quotes are the only
 * characters that cannot appear literally inside a single-quoted string.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
