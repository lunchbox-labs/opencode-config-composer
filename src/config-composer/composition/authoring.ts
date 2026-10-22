import { applyEdits, findNodeAtLocation, modify, parseTree } from 'jsonc-parser';
import { parseConfiguration } from '../configuration.ts';
import { SettingsError } from '../settings.ts';
import { readCompositionDocument } from './document.ts';
import type { Group } from './document-types.ts';

export type SettingsTarget = { profile?: string; kind: 'agent' | 'command' } & (
  { group: string; name?: never } | { name: string; group?: never }
);
const document = (text: string) => readCompositionDocument(parseConfiguration(text));
function tree(text: string) {
  const node = parseTree(text);
  if (node === undefined) {
    throw new SettingsError('Invalid Composer JSONC document.');
  }
  return node;
}
function change(text: string, path: (string | number)[], value: unknown): string {
  return applyEdits(
    text,
    modify(text, path, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' },
    }),
  );
}
function checked(text: string): string {
  document(text);
  return text;
}
function profilePath(text: string, profile?: string): string[] {
  if (profile === undefined) {
    return [];
  }
  if (!Object.hasOwn(document(text).profiles, profile)) {
    throw new SettingsError(`Unknown profile ${profile}.`);
  }
  return ['profiles', profile];
}
export function settingsPath(text: string, target: SettingsTarget): (string | number)[] {
  const base = profilePath(text, target.profile);
  if (target.group === undefined) {
    return [...base, target.kind, target.name];
  }
  const doc = document(text);
  if (!doc.groups.some((group) => group.name === target.group)) {
    throw new SettingsError(`Unknown group ${target.group}.`);
  }
  const groups = target.profile === undefined ? doc.groups : (doc.profiles[target.profile].groups ?? []);
  const index = groups.findIndex((group) => group.name === target.group);
  if (index < 0) {
    throw new SettingsError(`Add ${target.group} to Profile ${target.profile ?? ''} first.`);
  }
  return [...base, 'groups', index, target.kind];
}
export function setSetting(text: string, target: SettingsTarget, field: string, value: unknown): string {
  return checked(change(text, [...settingsPath(text, target), field], value));
}
export function setGlobal(
  text: string,
  profile: string | undefined,
  field: 'model' | 'small_model',
  value: string | undefined,
): string {
  return checked(change(text, [...profilePath(text, profile), field], value));
}
export function setDefault(text: string, profile: string | undefined): string {
  return checked(change(text, ['defaultProfile'], profile));
}
export function createProfile(text: string, name: string): string {
  if (Object.hasOwn(document(text).profiles, name)) {
    throw new SettingsError(`Profile ${name} already exists.`);
  }
  return checked(change(text, ['profiles', name], {}));
}
export function renameProfile(text: string, name: string, next: string): string {
  profilePath(text, name);
  if (Object.hasOwn(document(text).profiles, next)) {
    throw new SettingsError(`Profile ${next} already exists.`);
  }
  const node = findNodeAtLocation(tree(text), ['profiles', name]);
  const key = node?.parent?.children?.[0];
  if (key === undefined) {
    throw new SettingsError('Profile source changed.');
  }
  let result = text.slice(0, key.offset) + JSON.stringify(next) + text.slice(key.offset + key.length);
  if (document(text).defaultProfile === name) {
    result = change(result, ['defaultProfile'], next);
  }
  return checked(result);
}
export function deleteProfile(text: string, name: string): string {
  profilePath(text, name);
  let result = change(text, ['profiles', name], undefined);
  if (document(text).defaultProfile === name) {
    result = change(result, ['defaultProfile'], undefined);
  }
  return checked(result);
}
function groupIndex(text: string, name: string): number {
  const index = document(text).groups.findIndex((group) => group.name === name);
  if (index < 0) {
    throw new SettingsError(`Unknown group ${name}.`);
  }
  return index;
}
export function setDescription(
  text: string,
  value: string | undefined,
  target: { profile: string } | { group: string },
): string {
  const path = 'profile' in target ? profilePath(text, target.profile) : ['groups', groupIndex(text, target.group)];
  return checked(change(text, [...path, 'description'], value));
}
export function createGroup(text: string, name: string, members: Group['members']): string {
  const doc = document(text);
  if (doc.groups.some((group) => group.name === name)) {
    throw new SettingsError(`Group ${name} already exists.`);
  }
  return checked(change(text, ['groups', doc.groups.length], { name, members }));
}
export function setMembers(text: string, name: string, members: Group['members']): string {
  return checked(change(text, ['groups', groupIndex(text, name), 'members'], members));
}
export function renameGroup(text: string, name: string, next: string): string {
  const doc = document(text);
  if (doc.groups.some((group) => group.name === next)) {
    throw new SettingsError(`Group ${next} already exists.`);
  }
  let result = change(text, ['groups', groupIndex(text, name), 'name'], next);
  for (const [profile, value] of Object.entries(doc.profiles)) {
    value.groups?.forEach((group, index) => {
      if (group.name === name) {
        result = change(result, ['profiles', profile, 'groups', index, 'name'], next);
      }
    });
  }
  return checked(result);
}
export function deleteGroup(text: string, name: string): string {
  const doc = document(text);
  let result = change(text, ['groups', groupIndex(text, name)], undefined);
  for (const [profile, value] of Object.entries(doc.profiles)) {
    const index = value.groups?.findIndex((group) => group.name === name) ?? -1;
    if (index >= 0) {
      result = change(result, ['profiles', profile, 'groups', index], undefined);
    }
  }
  return checked(result);
}
export function setProfileGroup(text: string, profile: string, name: string, included: boolean): string {
  profilePath(text, profile);
  groupIndex(text, name);
  const groups = document(text).profiles[profile].groups ?? [];
  const index = groups.findIndex((group) => group.name === name);
  if (included === index >= 0) {
    return text;
  }
  return checked(
    change(text, ['profiles', profile, 'groups', included ? groups.length : index], included ? { name } : undefined),
  );
}
export function moveGroup(text: string, name: string, direction: -1 | 1, profile?: string): string {
  const doc = document(text);
  const path = [...profilePath(text, profile), 'groups'];
  const groups = profile === undefined ? doc.groups : (doc.profiles[profile].groups ?? []);
  const index = groups.findIndex((group) => group.name === name);
  if (index < 0 || index + direction < 0 || index + direction >= groups.length) {
    return text;
  }
  const root = tree(text);
  const first = findNodeAtLocation(root, [...path, Math.min(index, index + direction)]);
  const second = findNodeAtLocation(root, [...path, Math.max(index, index + direction)]);
  if (first === undefined || second === undefined) {
    throw new SettingsError('Group source changed.');
  }
  // Swap only the two object spans: comments elsewhere in the array remain byte-for-byte intact.
  return checked(
    text.slice(0, first.offset) +
      text.slice(second.offset, second.offset + second.length) +
      text.slice(first.offset + first.length, second.offset) +
      text.slice(first.offset, first.offset + first.length) +
      text.slice(second.offset + second.length),
  );
}
export function assignGroupModels(
  text: string,
  profile: string,
  names: string[],
  model: string,
  variant?: string,
): string {
  let result = text;
  for (const group of names) {
    result = setProfileGroup(result, profile, group, true);
    result = setSetting(result, { profile, group, kind: 'agent' }, 'model', model);
    if (variant !== undefined) {
      result = setSetting(result, { profile, group, kind: 'agent' }, 'variant', variant);
    }
  }
  return result;
}
