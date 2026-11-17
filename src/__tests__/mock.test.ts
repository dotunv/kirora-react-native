import * as mock from '../jest';
import * as real from '../index';

test('the Jest mock has every method and export of the real SDK', () => {
  const k = new mock.Kirora({ clientKey: 'kirora_pk_t' });
  const methods = Object.getOwnPropertyNames(real.Kirora.prototype).filter((m) => m !== 'constructor');
  for (const m of methods) expect(typeof (k as any)[m]).toBe('function');
  expect(Object.keys(mock).sort()).toEqual(Object.keys(real).sort());
});

test('its methods answer as a working SDK would and record their calls', async () => {
  const k = new mock.Kirora({ clientKey: 'kirora_pk_t' });
  k.track('Order Completed', { id: 1 });
  expect(k.track).toHaveBeenCalledWith('Order Completed', { id: 1 });
  await expect(k.identify()).resolves.toBeUndefined();
  expect((await k.getState()).isInitialized).toBe(true);
});
