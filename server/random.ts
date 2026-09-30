import { randomInt } from 'node:crypto';

export interface DiceSource {
  label: string;
  prepare(): Promise<void>;
  draw(sides: number): number;
}

// Uses the host OS cryptographic entropy source through Node's built-in crypto.
// randomInt uses rejection sampling, avoiding the modulo bias of naive mappings.
// No network service, API key, package, seed chosen by the model, or Math.random.
export const localDice: DiceSource = {
  label: 'Local OS cryptographic randomness',
  prepare: async () => undefined,
  draw(sides: number) {
    if (!Number.isInteger(sides) || sides < 2 || sides > 100)
      throw new Error('Die size must be an integer between 2 and 100.');
    return randomInt(1, sides + 1);
  },
};
