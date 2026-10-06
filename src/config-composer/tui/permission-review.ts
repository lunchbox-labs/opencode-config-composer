import type { PermissionWarning } from '../composition/permission-runtime.ts';

/** Keep the candidate's scope and fallback visible before verbose paths and rule listings. */
export function permissionReview(warnings: readonly PermissionWarning[]): string {
  if (warnings.length === 0) {
    return '';
  }
  const agents = warnings.filter(({ scope }) => scope !== 'global').map(({ scope }) => scope.slice(6));
  const shown: string[] = [];
  for (const name of agents.slice(0, 6)) {
    if (shown.join(', ').length + name.length > 240) {
      break;
    }
    shown.push(name);
  }
  const remaining = agents.length - shown.length;
  const scope = `${shown.map((name) => `Agent ${name}:`).join(' ')}${remaining === 0 ? '' : ` ${remaining} additional agent scopes:`}`;
  return [
    'Fallback may be more permissive, including missing intended deny rules. Other settings continue to apply.',
    ...(warnings.some(({ scope }) => scope === 'global')
      ? [
          'Global scope: Composer global permissions were not applied; native global permissions and independent agent policies remain.',
        ]
      : []),
    ...(agents.length === 0
      ? []
      : [
          `${scope.trim()} All Composer permission contributions for ${agents.length === 1 ? 'this agent were' : 'these agents were'} not applied; native agent permissions and the successfully applied global policy remain.`,
        ]),
    '',
    '',
  ].join('\n');
}
