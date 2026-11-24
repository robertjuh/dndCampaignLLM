import { z } from 'zod';

/** Publish the same bounds/types we validate; retain the tool's field descriptions. */
export function modelSchema(schema: z.ZodTypeAny, hints: Record<string, any> = {}): Record<string, any> {
  const def = schema._def;
  const kind = def.typeName;
  if (kind === 'ZodOptional' || kind === 'ZodDefault') return modelSchema(def.innerType, hints);
  if (kind === 'ZodEffects') return modelSchema(def.schema, hints);
  if (kind === 'ZodNullable') return { description: hints.description, anyOf: [modelSchema(def.innerType, hints), { type: 'null' }] };
  if (kind === 'ZodObject') {
    // Images are attached by the server, never authored by the game model.
    const shape: Record<string, z.ZodTypeAny> = Object.fromEntries(
      Object.entries(def.shape()).filter(([key]) => !['iconId', 'portraitId', 'portraitError'].includes(key)),
    ) as Record<string, z.ZodTypeAny>;
    return { description: hints.description, type: 'object', additionalProperties: false,
      properties: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, modelSchema(value, hints.properties?.[key])])),
      required: Object.entries(shape).filter(([, value]) => !value.isOptional()).map(([key]) => key) };
  }
  if (kind === 'ZodArray') return { description: hints.description, type: 'array',
    items: modelSchema(def.type, hints.items), ...(def.minLength ? { minItems: def.minLength.value } : {}),
    ...(def.maxLength ? { maxItems: def.maxLength.value } : {}) };
  if (kind === 'ZodUnion' || kind === 'ZodDiscriminatedUnion')
    return { description: hints.description, anyOf: [...def.options].map((option: z.ZodTypeAny) => modelSchema(option)) };
  if (kind === 'ZodEnum') return { description: hints.description, type: 'string', enum: def.values };
  if (kind === 'ZodLiteral') return { description: hints.description, type: typeof def.value, const: def.value };
  if (kind === 'ZodBoolean') return { description: hints.description, type: 'boolean' };
  if (kind === 'ZodNull') return { type: 'null' };
  if (kind === 'ZodRecord') return { type: 'object', additionalProperties: modelSchema(def.valueType) };
  if (kind !== 'ZodString' && kind !== 'ZodNumber') throw new Error(`Unsupported model schema ${kind}.`);
  const result: Record<string, any> = { description: hints.description, type: kind === 'ZodString' ? 'string' : 'number' };
  for (const check of def.checks ?? []) {
    if (check.kind === 'int') result.type = 'integer';
    if (check.kind === 'min') result[kind === 'ZodString' ? 'minLength' : check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value;
    if (check.kind === 'max') result[kind === 'ZodString' ? 'maxLength' : check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value;
    // Model IDs may be short aliases; UUID validation follows server expansion.
    if (check.kind === 'regex') result.pattern = check.regex.source;
  }
  return result;
}

/** Encode optional fields as a sparse list of typed single-field objects. This keeps
 * absence distinct from a saved null and avoids asking for every optional game effect. */
export function strictOutputFormat(name: string, shape: z.ZodTypeAny) {
  type Schema = Record<string, any>;
  function strict(node: Schema): Schema {
    if (node.anyOf) return { anyOf: node.anyOf.map(strict) };
    if (node.items) return { ...node, items: strict(node.items) };
    if (node.type !== 'object') return node;
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      const entry = object({ key: { type: 'string' }, value: strict(node.additionalProperties) });
      return object({ $entries: { type: 'array', items: entry } });
    }
    const properties: Record<string, Schema> = {};
    const optional: Schema[] = [];
    for (const [key, child] of Object.entries<Schema>(node.properties)) {
      const field = strict(child);
      if (node.required.includes(key)) properties[key] = field;
      else optional.push(object({ [key]: field }));
    }
    if (optional.length)
      properties.$optional = { type: 'array', maxItems: optional.length, items: { anyOf: optional } };
    return object(properties);
  }
  function object(properties: Record<string, Schema>) {
    return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
  }
  return { type: 'json_schema', name, strict: true, schema: strict(modelSchema(shape)) };
}

export function decodeStructuredOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeStructuredOutput);
  if (!value || typeof value !== 'object') return value;
  if (Object.keys(value).length === 1 && '$entries' in value) {
    const entries = z.array(z.object({ key: z.string(), value: z.unknown() }).strict()).parse(value.$entries);
    if (new Set(entries.map((entry) => entry.key)).size !== entries.length)
      throw new Error('Each property needs a unique key.');
    return Object.fromEntries(entries.map((entry) => [entry.key, decodeStructuredOutput(entry.value)]));
  }
  const { $optional, ...required } = value as Record<string, unknown>;
  const fields = Object.entries(required);
  if ($optional !== undefined) {
    for (const option of z.array(z.record(z.unknown())).parse($optional)) {
      const entries = Object.entries(option);
      if (entries.length !== 1) throw new Error('Each optional entry needs one named field.');
      fields.push(entries[0]);
    }
    if (new Set(fields.map(([key]) => key)).size !== fields.length)
      throw new Error('Supply each optional field once.');
  }
  return Object.fromEntries(fields.map(([key, field]) => [key, decodeStructuredOutput(field)]));
}
