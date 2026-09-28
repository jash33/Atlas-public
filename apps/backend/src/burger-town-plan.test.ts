import { describe, expect, it } from 'vite-plus/test';

import { defaultBurgerTownPlan, loadBurgerTownPlan } from './burger-town-plan.js';

describe('Burger Town connection plan', () => {
  it('derives operations from OpenAPI by default', () => {
    expect(defaultBurgerTownPlan).toEqual({
      serviceId: 'burger-town',
      operations: [],
    });
    expect(loadBurgerTownPlan({})).toBe(defaultBurgerTownPlan);
  });

  it('accepts a complete plan from configuration', () => {
    const configured = { ...defaultBurgerTownPlan, serviceId: 'burger-town-next' };
    expect(loadBurgerTownPlan({ ATLAS_BURGER_TOWN_PLAN_JSON: JSON.stringify(configured) })).toEqual(
      configured,
    );
  });
});
