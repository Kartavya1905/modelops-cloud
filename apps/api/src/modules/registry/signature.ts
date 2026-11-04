import { z } from 'zod';
import type { FieldError } from '../../common/errors/app-error';

/**
 * signature.json contract (written by ml/modelops_ml/bundle.py).
 * Validated strictly at registration: it is untrusted input from an MLflow run, and later the
 * gateway (M5) builds request validation and the UI builds the playground form from it.
 */
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;

const TensorSpec = z
  .object({
    name: z.string().regex(NAME),
    dtype: z.enum(['float32', 'float64', 'int32', 'int64', 'bool']),
    shape: z.array(z.number().int().min(-1)).min(1).max(8),
    features: z.array(z.string().regex(NAME)).min(1).max(1024).optional(),
    classes: z
      .array(z.union([z.number().int(), z.string().max(64)]))
      .min(2)
      .max(1000)
      .optional(),
  })
  .strict();

export const SignatureSchema = z
  .object({
    signatureVersion: z.literal(1),
    task: z.literal('binary_classification'),
    inputs: z.array(TensorSpec).min(1).max(16),
    outputs: z.array(TensorSpec).min(1).max(16),
  })
  .strict()
  .superRefine((sig, ctx) => {
    sig.inputs.forEach((input, i) => {
      const width = input.shape[1];
      if (input.features && width !== undefined && width >= 0 && input.features.length !== width) {
        ctx.addIssue({
          code: 'custom',
          path: ['inputs', i, 'features'],
          message: `has ${String(input.features.length)} names but shape[1] is ${String(width)}`,
        });
      }
    });
    const names = [...sig.inputs, ...sig.outputs].map((t) => t.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: 'custom', path: ['outputs'], message: 'tensor names must be unique' });
    }
  });

export type Signature = z.infer<typeof SignatureSchema>;

export function parseSignature(
  text: string,
): { ok: true; value: Signature } | { ok: false; errors: FieldError[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ field: 'signature.json', message: 'is not valid JSON' }] };
  }
  const result = SignatureSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => ({
      field: ['signature', ...i.path.map(String)].join('.'),
      message: i.message,
    })),
  };
}
