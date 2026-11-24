import type { Ability, Character } from '../shared/schema';

export type ImageSubject = {
  name: string;
  kind: string;
  description: string;
  theme: string;
  ability?: Pick<Ability, 'effect' | 'targeting' | 'inflicts' | 'cures'>;
};

/** Only visual identity reaches the local portrait model. */
export function portraitSubject(
  person: Pick<Character, 'name' | 'appearance'> & Partial<Pick<Character, 'species' | 'concept'>>,
  theme = '',
): ImageSubject {
  return {
    name: person.name.slice(0, 100),
    kind: 'portrait',
    description: [person.species, person.appearance, person.concept].filter(Boolean).join('\n').slice(0, 700),
    theme: theme.slice(0, 2400),
  };
}
