import { describe, expect, it } from 'vite-plus/test';

import { validationAdaptation } from './workflow-planning.js';

describe('validationAdaptation', () => {
  it('offers a production environment switch from development', () => {
    const adaptation = validationAdaptation('development');

    expect(adaptation.question).toBe(
      'Some requested operations or field mappings are not available in development. How should Atlas adapt the workflow?',
    );
    expect(adaptation.suggestedAnswers).toEqual([
      'Switch to production and review this request',
      'Keep the valid parts and omit unavailable operations',
      'Simplify to the smallest valid workflow that satisfies the core request',
    ]);
    expect(adaptation.suggestedAnswerActions).toEqual([
      {
        answer: 'Switch to production and review this request',
        action: 'change-environment',
        environmentId: 'production',
      },
    ]);
  });
});
