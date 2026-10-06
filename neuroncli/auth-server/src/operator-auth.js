export async function isOperator(c) {
  const expected = c.env.GATEWAY_ADMIN_TOKEN;
  const supplied = c.req.header('Authorization')?.replace(/^Bearer /, '');
  if (typeof expected !== 'string' || expected.length < 32 || typeof supplied !== 'string') return false;
  const hash = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [left, right] = await Promise.all([hash(expected), hash(supplied)]);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}
