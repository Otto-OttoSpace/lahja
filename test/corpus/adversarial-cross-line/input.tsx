// Bug #1 guard: a TS generic '>' must NEVER weld to a later '<' as "JSX text".
function first<T>(items: Array<string>): T {
  const list: Map<string, number> = new Map();
  const n: Array<number> = [];
  return items as unknown as T;
}

const compare = (a: number, b: number) => a > b && b < a;
export { first, compare };
