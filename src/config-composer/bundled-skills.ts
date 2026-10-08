import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { configurationFile } from './configuration.ts';
import { SettingsError, record } from './settings.ts';

export const bundledSkillDirectory = fileURLToPath(new URL('../../skills/', import.meta.url));
const resources = {
  'config-composer-explain': ['references/schema.md'],
  'config-composer-create': ['examples/review.jsonc'],
  'config-composer-migrate': ['examples/before.jsonc', 'examples/after.jsonc', 'examples/worker.md'],
};

/** Validate only this package's declared resources; this is not composition directory discovery. */
export async function validateBundledSkills(directory = bundledSkillDirectory): Promise<void> {
  for (const [name, references] of Object.entries(resources)) {
    const path = join(directory, name, 'SKILL.md');
    try {
      const { text } = await configurationFile(path);
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      const document = parseDocument(frontmatter?.[1] ?? '', { uniqueKeys: true });
      const metadata: unknown = document.toJS({ maxAliasCount: 0 });
      if (
        document.errors.length !== 0 ||
        !record(metadata) ||
        metadata.name !== name ||
        typeof metadata.description !== 'string' ||
        metadata.description.trim() === ''
      ) {
        throw new SettingsError('The bundled skill identity or frontmatter is invalid.');
      }
      for (const reference of references) {
        await configurationFile(join(directory, name, reference));
      }
    } catch (error) {
      throw new SettingsError(
        `Could not load bundled skill resource ${path}. Reinstall Config Composer with its packaged skills. ${error instanceof Error ? error.message : ''}`,
      );
    }
  }
}
