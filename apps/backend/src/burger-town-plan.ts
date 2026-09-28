import { z } from 'zod';

import type { BurgerTownConnectionPlan } from './burger-town-connection.js';

export const defaultBurgerTownPlan: BurgerTownConnectionPlan = {
  serviceId: 'burger-town',
  operations: [],
};

export function loadBurgerTownPlan(environment: NodeJS.ProcessEnv = process.env) {
  const configured = environment.ATLAS_BURGER_TOWN_PLAN_JSON;
  if (!configured) return defaultBurgerTownPlan;
  try {
    return JSON.parse(configured) as BurgerTownConnectionPlan;
  } catch (error) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['ATLAS_BURGER_TOWN_PLAN_JSON'],
        message: error instanceof Error ? error.message : 'Plan must be valid JSON',
      },
    ]);
  }
}
