export function fmt(d: Date) {
  const bad = d.toLocaleDateString();
  const good = d.toLocaleDateString('en-US');
  return bad + good;
}
