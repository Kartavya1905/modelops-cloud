import { describe, expect, it } from 'vitest';
import { parseSignature } from '../../src/modules/registry/signature';

const valid = {
  signatureVersion: 1,
  task: 'binary_classification',
  inputs: [{ name: 'features', dtype: 'float32', shape: [-1, 2], features: ['a', 'b'] }],
  outputs: [
    { name: 'label', dtype: 'int64', shape: [-1] },
    { name: 'probabilities', dtype: 'float32', shape: [-1, 2], classes: [0, 1] },
  ],
};
const parse = (v: unknown) => parseSignature(JSON.stringify(v));

describe('signature.json parsing (untrusted input from an MLflow run)', () => {
  it('accepts the bundle format written by ml/modelops_ml', () => {
    expect(parse(valid)).toEqual({ ok: true, value: valid });
  });

  it('rejects invalid JSON', () => {
    expect(parseSignature('{nope')).toMatchObject({
      ok: false,
      errors: [{ field: 'signature.json' }],
    });
  });

  it.each([
    ['unknown top-level key', { ...valid, exec: 'rm -rf /' }],
    ['unsupported dtype', { ...valid, inputs: [{ ...valid.inputs[0], dtype: 'object' }] }],
    [
      'tensor name with path characters',
      { ...valid, inputs: [{ ...valid.inputs[0], name: '../etc' }] },
    ],
    ['feature count != width', { ...valid, inputs: [{ ...valid.inputs[0], shape: [-1, 3] }] }],
    [
      'duplicate tensor names',
      { ...valid, outputs: [valid.outputs[0], { ...valid.outputs[1], name: 'label' }] },
    ],
    ['wrong version', { ...valid, signatureVersion: 2 }],
    ['no inputs', { ...valid, inputs: [] }],
    [
      'absurd rank',
      { ...valid, inputs: [{ name: 'x', dtype: 'float32', shape: Array(9).fill(1) }] },
    ],
  ])('rejects %s', (_label, sig) => {
    const r = parse(sig);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });

  it('reports precise field paths', () => {
    const r = parse({ ...valid, inputs: [{ ...valid.inputs[0], shape: [-1, 3] }] });
    expect(!r.ok && r.errors[0]?.field).toBe('signature.inputs.0.features');
  });
});
