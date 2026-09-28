import assert from 'node:assert/strict';

const baseUrl = process.env.BURGER_TOWN_URL ?? 'http://localhost:43123';
async function request(path, body, method = 'POST') {
  const response = await fetch(new URL(path, baseUrl), {
    method: body === undefined ? 'GET' : method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
const toggle = (broken) => request('/v1/__control/contract', { broken });
const reset = () => request('/v1/__control/resources', { mode: 'replace', resources: [] }, 'PUT');
const probe = () => request('/v1/__control/probe/addItem', { item_id: 'itm_fries', quantity: 1 });
const requiredFields = async () => {
  const result = await request('/openapi.json');
  return result.body.paths['/v1/checks/{check_id}/items'].post.requestBody.content[
    'application/json'
  ].schema.required;
};

// Explicit presenter check: resets the separate Burger Town restaurant before and after.
try {
  assert.equal((await toggle(false)).status, 200);
  assert.equal((await reset()).status, 200);
  const before = await request('/v1/__control/observations');
  assert.equal((await probe()).status, 200);
  const after = await request('/v1/__control/observations');
  assert.deepEqual(
    after.body.durableState,
    before.body.durableState,
    'Polling must leave restaurant state unchanged',
  );
  assert.deepEqual(after.body.sideEffects, before.body.sideEffects);
  assert.equal((await requiredFields()).includes('kitchen_note'), false);
  const baselineSpec = (await request('/openapi.json')).body;
  for (const name of ['Fulfillment', 'Check']) {
    assert.ok(
      baselineSpec.components.schemas[name].required.includes('id'),
      `${name} must guarantee the ID used by downstream workflow steps`,
    );
  }

  await toggle(true);
  const failedProbe = await probe();
  assert.equal(failedProbe.status, 400);
  assert.deepEqual(failedProbe.body, {
    code: 'required_field_missing',
    fieldPath: 'kitchen_note',
    message: 'kitchen_note is required',
  });
  const failedActual = await request('/v1/checks/chk_ok/items', {
    item_id: 'itm_fries',
    quantity: 1,
  });
  assert.equal(failedActual.status, 400);
  assert.deepEqual(
    failedActual.body,
    failedProbe.body,
    'The real API and polling probe must enforce the same change',
  );
  assert.equal((await requiredFields()).filter((field) => field === 'kitchen_note').length, 1);
  assert.equal((await requiredFields()).filter((field) => field === 'kitchen_note').length, 1);

  await toggle(false);
  assert.equal((await requiredFields()).includes('kitchen_note'), false);
  assert.equal((await probe()).status, 200);
  assert.equal(
    (await request('/v1/checks/chk_ok/items', { item_id: 'itm_fries', quantity: 1 })).status,
    201,
  );
  const fulfillmentBody = {
    location_id: 'loc_oak',
    type: 'pickup',
    idempotency_key: 'control-test:fulfillment',
  };
  const [fulfillment, replayedFulfillment] = await Promise.all([
    request('/v1/fulfillments', fulfillmentBody),
    request('/v1/fulfillments', fulfillmentBody),
  ]);
  assert.equal(fulfillment.status, 201);
  assert.deepEqual(replayedFulfillment, fulfillment, 'Concurrent identical writes must replay');
  assert.equal(
    (await request('/v1/fulfillments', { ...fulfillmentBody, location_id: 'different' })).status,
    409,
  );
  const checkBody = {
    fulfillment_id: fulfillment.body.id,
    server_id: 'emp_jon',
    idempotency_key: 'control-test:check',
  };
  const check = await request('/v1/checks', checkBody);
  assert.equal(check.status, 201);
  assert.deepEqual(await request('/v1/checks', checkBody), check);
  const itemBody = { item_id: 'itm_fries', quantity: 1, idempotency_key: 'control-test:item' };
  const itemPath = `/v1/checks/${check.body.id}/items`;
  const item = await request(itemPath, itemBody);
  assert.equal(item.status, 201);
  assert.deepEqual(await request(itemPath, itemBody), item);
  const sendBody = { idempotency_key: 'control-test:send' };
  const sendPath = `/v1/checks/${check.body.id}/send`;
  const sent = await request(sendPath, sendBody);
  assert.equal(sent.status, 200);
  assert.deepEqual(await request(sendPath, sendBody), sent);
  const observations = (await request('/v1/__control/observations')).body;
  assert.equal(
    observations.sideEffects.filter((effect) => effect.operationId === 'createFulfillment').length,
    1,
  );
  assert.equal(
    observations.sideEffects.filter((effect) => effect.operationId === 'createCheck').length,
    1,
  );
  assert.equal(
    observations.sideEffects.filter((effect) => effect.operationId === 'sendOrder').length,
    1,
  );
  console.log(
    'Burger Town controls passed: isolated baseline, real contract failure, schema update, recovery, and real replay for all four writes.',
  );
} finally {
  await toggle(false);
  await reset();
}
