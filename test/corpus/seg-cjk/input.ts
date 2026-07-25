// CJK: .length counts UTF-16 code units and .slice cuts mid-grapheme.
export function preview(n: number) {
  const zh = '你好世界这是一段很长的文本';
  const count = zh.length;
  const head = '你好世界'.slice(0, 2);
  return { count, head, tail: zh.slice(0, n) };
}
