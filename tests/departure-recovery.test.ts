import { expect, it, vi } from 'vitest';
import type { GMContext, GameTools } from '../server/game';
import type { ChatGPTAuth } from '../server/auth';
import { ChatGPTGM } from '../server/providers';
import { prepareEncounterChecks } from '../server/encounters';
import {
  engineEvents,
  normalizeAdjudicationStructure,
  validateAdjudication,
} from '../server/turn-resolution';
import { advanceWorldProgression } from '../server/world-progression';
import { initialState } from '../shared/rules';
import { campaignSchema, templateCharacter, type Scene, type Roll } from '../shared/schema';
import { turnAdjudicationSchema, type TurnAdjudication } from '../shared/turn-resolution';
import saved from './fixtures/spacepirates-departure.json';

it.each(['consolidated', 'malformed'] as const)(
  'resolves the recorded departure with %s journal repair and no repeated check',
  async (repair) => {
    const members = [saved.actorId, saved.passengerId].map((id, index) => {
      const character = templateCharacter(index ? 'Rustbeard' : 'Ragman');
      return {
        id,
        playerId: id,
        characterId: id,
        playerName: character.name,
        character,
        active: index === 0,
        state: initialState(character, id),
      };
    });
    const context: GMContext = {
      config: campaignSchema.parse({
        name: 'Spacepirates departure replay',
        setting: 'A spaceport',
        premise: 'Travel to IJzerkeel.',
        provider: 'chatgpt',
        language: 'Nederlands',
        tone: '',
        instructions: '',
        custom: [],
      }),
      members,
      startingMembers: structuredClone(members),
      scene: structuredClone(saved.scene) as unknown as Scene,
      journal: saved.journal as GMContext['journal'],
      history: [],
      receipts: {},
      turn: {
        id: saved.turnId,
        number: 22,
        phase: 'resolving',
        roster: [saved.actorId],
        actions: [{ memberId: saved.actorId, text: 'We varen naar ijzerkeel', passed: false }],
        rolls: structuredClone(saved.rolls) as Roll[],
        result: null,
        error: null,
      },
      requestBudget: { used: 0, limit: 8 },
    };
    const engine = engineEvents(context);
    const normalized = normalizeAdjudicationStructure(context, saved.adjudication) as TurnAdjudication;
    const complete = turnAdjudicationSchema.parse({
      ...normalized,
      events: [...engine, ...normalized.events],
    });
    // The existing semantic repair can consolidate a full journal from established facts.
    complete.journal[0].detail = `${saved.adjudication.journal[0].detail}\n${complete.events.find((event) => event.id === 'afvaart-2')!.fact}`;
    const patch = {
      ...complete,
      events: complete.events.filter((event) => !engine.some((saved) => saved.id === event.id)),
    };
    const requests: any[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init!.body as string));
      const text =
        requests.length === 1
          ? JSON.stringify(saved.adjudication)
          : repair === 'malformed'
            ? '{'
            : JSON.stringify(patch);
      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
          },
        })}\n\n`,
      );
    }) as unknown as typeof fetch;
    const draw = vi.fn(() => {
      throw new Error('The saved departure check must not roll again.');
    });
    const tools = Object.assign(draw, {
      validateAdjudication: (input: unknown) => validateAdjudication(context, input),
      prepareEncounters: (value: TurnAdjudication) =>
        prepareEncounterChecks(context, value, {}, draw).required,
    }) as unknown as GameTools;
    const gm = new ChatGPTGM(
      { accessToken: async () => 'test' } as unknown as ChatGPTAuth,
      'owner',
      'test',
      fetcher,
    );
    if (repair === 'malformed') {
      await expect(gm.adjudicate(context, tools)).rejects.toThrow('could not finish the story consequences');
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(draw).not.toHaveBeenCalled();
      expect(context.turn.rolls).toEqual(saved.rolls);
      return;
    }
    const result = await gm.adjudicate(context, tools);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(draw).not.toHaveBeenCalled();
    expect(context.turn.rolls).toEqual(saved.rolls);
    expect(result.actions[0].components.main).toMatchObject({ status: 'success', basis: 'check' });
    expect(result.events[0]).toEqual(engine[0]);
    expect(result.memberLocations ?? []).toEqual([]);
    expect(context.scene.memberLocations![saved.passengerId]).toBe(saved.deckId);
    expect(() => validateAdjudication(context, result)).not.toThrow();
    expect(context.requestBudget!.corrections![0].feedback).toContain('Consolidate journal');
    const state = advanceWorldProgression(context, result, (ref) => ref)!;
    if (repair === 'consolidated') {
      expect(result.mapUpdates!.connections).toContainEqual(
        expect.objectContaining({
          from: saved.dockId,
          to: saved.deckId,
          blocked: true,
        }),
      );
      expect(result.events.some((event) => event.id === 'afvaart-1')).toBe(true);
      expect(result.journal[0].detail.length).toBeLessThanOrEqual(1500);
      expect(result.rewards.xp).toBe(20);
      expect(state.places[saved.bridgeId].stalledTurns).toBe(0);
    } else {
      expect(result.mapUpdates?.connections ?? []).toEqual([]);
      expect(result.events.some((event) => event.id === 'afvaart-1')).toBe(false);
      expect(result.rewards.xp).toBe(0);
      expect(state.places[saved.bridgeId].stalledTurns).toBe(2);
      expect(context.requestBudget!.fallback).toContain('Adjudication stopped');
    }
  },
);
