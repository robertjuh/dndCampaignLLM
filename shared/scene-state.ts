import { z } from 'zod';
import type { Scene } from './schema';

const name = z.string().trim().min(1).max(100);
const properties = z.record(
  z.string().trim().min(1).max(60),
  z.union([z.string().max(500), z.boolean(), z.number().finite(), z.null()]),
);
const route = z.object({ from: name, to: name }).strict();

export const sceneFeatureSchema = z
  .object({
    id: name,
    name,
    aliases: z.array(name),
    locationId: name,
    properties,
    route: route.nullable().optional(),
    fact: z.string().trim().min(1).max(2500),
  })
  .strict();
export type SceneFeature = z.infer<typeof sceneFeatureSchema>;

export const featureUpdateSchema = sceneFeatureSchema
  .omit({ id: true, fact: true })
  .extend({
    featureId: name,
    aliases: z.array(name).max(12).optional(),
    properties: properties
      .refine((value) => Object.keys(value).length <= 20, 'Update at most twenty properties.')
      .optional(),
    passable: z.boolean().optional(),
    eventId: z.string().min(1).max(200),
  })
  .strict();

export const featureNameKey = (text: string) => text.normalize('NFKC').trim().toLowerCase();
export function findSceneFeature(scene: Pick<Scene, 'features'>, ref: string, locationId?: string) {
  if (scene.features && Object.hasOwn(scene.features, ref)) return scene.features[ref];
  const matches = Object.values(scene.features ?? {}).filter(
    (feature) =>
      (!locationId || feature.locationId === locationId) &&
      [feature.name, ...feature.aliases].some((name) => featureNameKey(name) === featureNameKey(ref)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function featureConnection(scene: Pick<Scene, 'worldMap'>, route: SceneFeature['route']) {
  return (
    route &&
    scene.worldMap?.connections.find(
      (edge) =>
        (edge.from === route.from && edge.to === route.to) ||
        (edge.from === route.to && edge.to === route.from),
    )
  );
}

export function featurePublicFact(feature: SceneFeature, scene: Pick<Scene, 'worldMap'>) {
  const connection = featureConnection(scene, feature.route);
  const properties = { ...feature.properties };
  if (connection) delete properties.passable;
  return `${feature.name}. Current properties: ${JSON.stringify(properties)}.${
    connection ? ` Passage: ${connection.blocked ? 'blocked' : 'open'}.` : ''
  } ${feature.fact}`;
}
