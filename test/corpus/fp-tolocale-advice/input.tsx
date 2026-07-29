export function Clock(d: Date) {
  const label = 'التاريخ اليوم';
  return <time>{d.toLocaleDateString()}</time>;
}
