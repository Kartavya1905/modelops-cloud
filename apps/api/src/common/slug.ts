import { randomBytes } from 'node:crypto';

/** "Churn Prediction v2!" -> "churn-prediction-v2" (ASCII, max 48 chars). */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'item';
}

/** Slug with a short random suffix, for names that need to be globally unique (organizations). */
export function uniqueSlug(input: string): string {
  return `${slugify(input).slice(0, 40)}-${randomBytes(3).toString('hex')}`;
}
