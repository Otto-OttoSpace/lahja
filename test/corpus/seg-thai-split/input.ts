// Thai has no inter-word spaces — split(' ') never finds a word boundary.
export function toWords(): string[] {
  const th = 'สวัสดีชาวโลกนี่คือข้อความยาว';
  return th.split(' ');
}
