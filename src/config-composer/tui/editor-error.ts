import { SettingsError } from '../settings.ts';

export function credentialKey(key: string): boolean {
  const name = key.toLowerCase().replaceAll(/[^a-z]/g, '');
  return (
    ['apikey', 'authorization', 'password', 'passwd', 'secret', 'credential', 'privatekey'].some((part) =>
      name.includes(part),
    ) ||
    name.endsWith('token') ||
    name === 'cookie'
  );
}

export function diagnosticText(value: string): string {
  // Keep line breaks for source locations, but remove terminal/control sequences.
  const clean = Array.from(value.slice(0, 24000))
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return char === '\n' || (code > 31 && (code < 127 || code > 159));
    })
    .join('');
  const redacted = clean
    .replaceAll(/https?:\/\/[^\s/]*@/gi, 'https://[redacted]@')
    // A credential assignment consumes the rest of its line, including quoted/multiword values.
    .split('\n')
    .map((line) => {
      for (const match of line.matchAll(/\b([\w-]+)["']?\s*[:=]/g)) {
        if (credentialKey(match[1])) {
          return `${line.slice(0, match.index)}${match[1]}=[redacted]`;
        }
      }
      return line;
    })
    .join('\n');
  return redacted.length > 6000 || value.length > 24000 ? `${redacted.slice(0, 6000)}… (truncated)` : redacted;
}

/** Display only known editor diagnostics; never retain raw errors, causes or stacks. */
export function editorErrorText(error: unknown): string {
  if (!(error instanceof SettingsError)) {
    return 'Could not update settings. Check the files and server connection.';
  }
  return diagnosticText(error.message);
}
