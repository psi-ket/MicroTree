import { AppSettingsSchema, type UpdateSettingsRequest } from '@research-studio/api-contracts';
import type { SettingsRepository } from '@research-studio/database';
import { DEFAULT_SETTINGS, type AppSettings } from '@research-studio/shared-types';
import type { z } from 'zod';

const GLOBAL_SCOPE = 'global';

export class SettingsService {
  constructor(private readonly repo: SettingsRepository) {}

  /** Stored values merged over defaults; invalid stored values fall back to the default. */
  get(): AppSettings {
    const stored = this.repo.getAll(GLOBAL_SCOPE);
    const result: AppSettings = { ...DEFAULT_SETTINGS };
    const shape = AppSettingsSchema.shape;
    for (const key of Object.keys(shape) as (keyof AppSettings)[]) {
      if (!(key in stored)) continue;
      const parsed = shape[key].safeParse(stored[key]);
      if (parsed.success) (result as unknown as Record<string, unknown>)[key] = parsed.data;
    }
    return result;
  }

  update(patch: z.infer<typeof UpdateSettingsRequest>): AppSettings {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length) this.repo.setMany(GLOBAL_SCOPE, Object.fromEntries(entries));
    return this.get();
  }
}
