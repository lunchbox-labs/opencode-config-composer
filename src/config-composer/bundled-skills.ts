import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurationFile } from './configuration.ts';
import { frontmatterData } from './frontmatter.ts';
import { SettingsError, record } from './settings.ts';

export const bundledSkillDirectory = fileURLToPath(new URL('../../skills/', import.meta.url));
const resources = {
  'config-composer-explain': ['references/schema.md'],
  'config-composer-create': ['examples/review.jsonc'],
};

/** Validate only this package's declared resources; this is not composition directory discovery. */
export async function validateBundledSkills(directory = bundledSkillDirectory): Promise<void> {
  for (const [name, references] of Object.entries(resources)) {
    let path = join(directory, name, 'SKILL.md');
    try {
      const { text } = await configurationFile(path);
      // js-yaml rejects duplicate keys, so a repeated field cannot silently replace the packaged identity.
      const metadata = frontmatterData(text, path);
      if (
        !record(metadata) ||
        metadata.name !== name ||
        typeof metadata.description !== 'string' ||
        metadata.description.trim() === ''
      ) {
        throw new SettingsError('The bundled skill identity or frontmatter is invalid.');
      }
      for (const reference of references) {
        path = join(directory, name, reference);
        await configurationFile(path);
      }
    } catch (error) {
      throw new SettingsError(
        `Could not load bundled skill resource ${path}. Reinstall Config Composer with its packaged skills. ${error instanceof Error ? error.message : ''}`,
      );
    }
  }
}
