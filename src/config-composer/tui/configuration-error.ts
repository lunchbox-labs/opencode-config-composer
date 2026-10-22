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

export function inspectionText(value: string): string {
  // Keep line breaks for source locations, but remove terminal/control sequences.
  const clean = Array.from(value)
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
  return redacted;
}
export function diagnosticText(value: string): string {
  const clean = inspectionText(value.slice(0, 24000));
  return clean.length > 6000 || value.length > 24000 ? `${clean.slice(0, 6000)}… (truncated)` : clean;
}

/** Display only known configuration diagnostics; never retain raw errors, causes or stacks. */
export function configurationErrorText(error: unknown): string {
  if (!(error instanceof SettingsError)) {
    return 'Could not read or apply configuration. Check the files and server connection.';
  }
  return diagnosticText(error.message);
}

export function diagnosticPages(value: string, columns: number, rows: number): string[] {
  const lines = value.split('\n').flatMap((line) => {
    const wrapped: string[] = [];
    let current = '';
    let width = 0;
    for (const char of line) {
      // Conservatively allow two terminal cells for non-Latin path characters.
      const cells = (char.codePointAt(0) ?? 0) > 255 ? 2 : 1;
      if (width + cells > columns && current !== '') {
        wrapped.push(current);
        current = '';
        width = 0;
      }
      current += char;
      width += cells;
    }
    wrapped.push(current);
    return wrapped;
  });
  const pages: string[] = [];
  for (let index = 0; index < lines.length; index += rows) {
    pages.push(lines.slice(index, index + rows).join('\n'));
  }
  return pages;
}
