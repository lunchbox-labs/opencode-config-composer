import type { PermissionWarning } from '../composition/permission-runtime.ts';

/** Keep the candidate's scope and fallback visible before verbose paths and rule listings. */
export function permissionReview(warnings: readonly PermissionWarning[]): string {
  if (warnings.length === 0) {
    return '';
  }
  return (
    warnings
      .map(({ scope }) =>
        scope === 'global'
          ? 'Global scope: Composer global permissions were not applied; native global permissions and independent agent policies remain.'
          : `Agent ${scope.slice(6)}: All Composer permission contributions for this agent were not applied; native agent permissions and the successfully applied global policy remain.`,
      )
      .join('\n') +
    '\nFallback may be more permissive, including missing intended deny rules. Other settings continue to apply.\n\n'
  );
}
