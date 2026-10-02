import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function validateRelease(manifest, tag) {
  if (manifest.private !== undefined && manifest.private !== false) {
    throw new Error('Remove the private publication guard only after release setup is approved.');
  }
  if (manifest.name !== '@lunchbox-labs/opencode-config-composer') {
    throw new Error('The npm package name must be @lunchbox-labs/opencode-config-composer.');
  }
  if (
    typeof manifest.version !== 'string' ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(manifest.version) ||
    manifest.version === '0.0.0'
  ) {
    throw new Error('Publishing requires a non-placeholder stable semantic version.');
  }
  if (tag !== `v${manifest.version}`) {
    throw new Error('The release tag must equal v followed by the package version.');
  }
  const access = manifest.publishConfig?.access;
  if (!['public', 'restricted'].includes(access) || (access === 'restricted' && !manifest.name.startsWith('@'))) {
    throw new Error('Set an approved publishConfig.access; restricted packages require a scope.');
  }
  if (manifest.repository?.url !== 'git+https://github.com/lunchbox-labs/opencode-config-composer.git') {
    throw new Error('The package repository must match the trusted publisher repository.');
  }
  if (
    manifest.publishConfig?.registry !== undefined &&
    manifest.publishConfig.registry !== 'https://registry.npmjs.org'
  ) {
    throw new Error('This workflow publishes only to https://registry.npmjs.org.');
  }
  return { name: manifest.name, version: manifest.version, access };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const result = validateRelease(manifest, process.env.RELEASE_TAG);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `access=${result.access}\n`);
  }
  console.log(`Validated ${result.name}@${result.version} for ${result.access} publication.`);
}
