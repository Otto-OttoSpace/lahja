export function preview() {
  const title = 'اسم المنتج طويل جدا';
  const zh = '你好世界这是一段很长的文本';
  if (zh.length) return 0;
  if (zh.length > 0) return 1;
  if (zh.length === 0) return 2;
  const count = zh.length;
  return { title, count };
}
